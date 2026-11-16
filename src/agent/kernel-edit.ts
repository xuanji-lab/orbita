/**
 * 新内核里一条会话的「本子编辑」：回退、撤销 / 挪工作区的告知、分支——旧内核 pi-book-edit.ts 与 runtime.ts 的
 * branchPiSession 在 durable 上的对位。不 import electron，`node --test` 直接测（MemoryStorage）。
 *
 * 守住的是旧内核的**对账规矩**：两本账（我们的转录、durable 的 entry）没有 id 映射，按 user / assistant 出现的顺序
 * 一一对应（branch-cut.ts 的 planCutEntry / planBranchCut，同一份函数）；对不上就拒绝，一条文件都不动（主进程 revert.ts
 * 先等这里回执再还原文件）。durable 的 entry 投影成 pi 本子的形状再交给它：
 * - pi.user / pi.assistant / pi.tool-result / orbita.backfill（失败轮补记的 user）/ orbita.channel（排在一句前面的子会话信封）
 *   = pi 的 message 条目；
 * - 其余（压缩、扩展消息、系统提示……）= 别的类型，不计入对账（与 pi 本子里 custom_message / compaction 不计同理）。
 *
 * 回退 = durable 的 fork(at)：新会话从裁点那一刻的上下文开始，索引改指向它；**被回退掉的几轮还在库里**
 * （原 conversation 只是不再被索引指着），与旧内核在 pi 本子里留废枝同一个意思。provider 会话 id 沿用
 * （旧内核回退不换本子，提示缓存的亲和不断；durable 的 fork 默认给新 id，这里在创建的同一次提交里写回）。
 * orbita.wire 是 rewindable / asOf：fork 拿到的是裁点那一刻的图片水位与记忆账（旧内核这些记在本子的 custom 条目里，
 * 回退时随枝回退）。回退到第一条消息之前（roles 为空，旧内核 resetLeaf）：建一条空会话。
 *
 * 分支 = 把源会话裁点之前的全部可见条目（含压缩之前的原始历史）复制进**新库**的一条新会话：一棵树一库，分出来的
 * 是新树的根；源会话所在的库删了，分支不受影响。provider 会话 id 是新的（旧内核 createBranchedSession 开新本子、新会话 id）。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import {
  ProviderDoc,
  type ContextEdit,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  type JsonObject,
  type Tx,
} from "@earendil-works/pi-durable";
import { planBranchCut, planCutEntry, type BranchCutEntry } from "./branch-cut.ts";
import { LEGACY_KINDS, legacyUsageOf } from "./legacy-migrate.ts";
import { messageSignature, WireDoc } from "./kernel-wire.ts";
import { CHANNEL_PREFACE_KIND, SessionHistoryDoc, SessionIndexDoc } from "./kernel.ts";

/** 对账里算作 pi「message 条目」的 entry 种类 */
const MESSAGE_KINDS = new Set([LEGACY_KINDS.user, LEGACY_KINDS.assistant, LEGACY_KINDS.toolResult, "orbita.backfill", CHANNEL_PREFACE_KIND]);

/** 回退 / 撤销 / 挪工作区：会话在跑时拒绝（旧内核 runtime.ts 同一句话；主进程按 phase 先筛过一道，这里是信任边界） */
export const RUNNING_REFUSAL = {
  revert: "the session is still running — stop it before reverting",
  undo: "the session is still running — stop it before undoing",
  move: "the session is still running — stop it before moving",
} as const;

/**
 * durable 的一条 entry → planCutEntry 认的形状。**只留对账要的字段**（角色、stopReason、content 空不空）：
 * 大会话几百 MB 的原文（图片、长工具结果）不跟着对账留在内存里。
 */
function cutEntryOf(entry: Pick<EntryRecord, "id" | "kind" | "model">): BranchCutEntry {
  const message = entry.model?.length === 1 ? entry.model[0] : undefined;
  if (!MESSAGE_KINDS.has(entry.kind) || message === undefined) return { type: entry.kind, id: String(entry.id) };
  const content = (message as { content?: unknown }).content;
  return {
    type: "message",
    id: String(entry.id),
    message: {
      role: message.role,
      stopReason: (message as { stopReason?: unknown }).stopReason,
      content: Array.isArray(content) && content.length === 0 ? [] : [null],
    },
  };
}

/** 一条会话从头到尾的可见条目（fork 的历史含父在裁点之前的那段），按 id 升序逐页读、逐条交给 visit */
async function eachEntry(conversation: Conversation, visit: (entry: EntryRecord) => void): Promise<void> {
  let cursor: Parameters<Conversation["entries"]>[2];
  for (;;) {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) visit(entry);
    if (page.next === undefined) return;
    cursor = page.next;
  }
}

/** 索引里这条会话现在指着的 conversation；没有（还没迁进来 / 已删）抛错 */
async function indexedConversation(harness: Harness, sessionId: string): Promise<Conversation> {
  const id = (await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions[sessionId];
  const conversation = id === undefined ? undefined : await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new Error(`session ${sessionId} is not in the durable library`);
  return conversation;
}

/** 在创建会话的那一次提交里：索引改指向它、记进这条会话的历史（用量按历史累计，删除按历史清） */
async function adopt(tx: Tx, sessionId: string, conversationId: ConversationId, fresh: boolean): Promise<void> {
  (await tx.doc(SessionIndexDoc)).sessions[sessionId] = conversationId;
  const history = await tx.doc(SessionHistoryDoc);
  history.sessions[sessionId] = fresh ? [conversationId] : [...(history.sessions[sessionId] ?? []), conversationId];
}

/**
 * 回退：裁到 roles 前缀之后（锚点连带它的工具结果），之后的条目留在库里但不再被索引指着。
 * 对账不过抛错（宁可回退失败，不切错位置）。
 */
export async function revertSession(harness: Harness, sessionId: string, roles: readonly ("user" | "assistant")[]): Promise<void> {
  const conversation = await indexedConversation(harness, sessionId);
  const entries: BranchCutEntry[] = [];
  await eachEntry(conversation, (entry) => entries.push(cutEntryOf(entry)));
  if (entries.every((entry) => entry.type !== "message") && roles.length > 0) throw new Error("pi book is empty — nothing to revert");
  const cut = planCutEntry(entries, roles);
  const providerSessionId = (await harness.snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT))?.sessionId;
  const init = async (tx: Tx, id: ConversationId): Promise<void> => {
    await adopt(tx, sessionId, id, false);
    if (providerSessionId !== undefined) (await tx.doc(ProviderDoc, id)).sessionId = providerSessionId;
  };
  if (cut === null) await harness.createConversation({ ownership: { kind: "ownerless" }, init }, BACKGROUND_CONTEXT);
  else await conversation.fork(Number(cut) as EntryId, { ownership: { kind: "ownerless" }, init }, BACKGROUND_CONTEXT);
}

/**
 * 撤销 / 挪工作区的告知：在会话末尾追加一条进上下文的扩展消息（旧内核 appendCustomMessageEntry(customType, notice, false)）。
 * 与迁来的扩展消息同形（orbita.legacy-custom + 指纹记进 orbita.wire）：逐请求注入时按旧内核的 custom 角色处理。
 */
export async function appendNotice(harness: Harness, sessionId: string, customType: "orbita-undo" | "orbita-move", notice: string, now: number): Promise<void> {
  const conversation = await indexedConversation(harness, sessionId);
  const message: UserMessage = { role: "user", content: [{ type: "text", text: notice }], timestamp: now };
  await conversation.commit(async (tx) => {
    await tx.appendEntry(conversation.id, { kind: LEGACY_KINDS.custom, model: [message], data: { customType, display: false } });
    const wire = await tx.doc(WireDoc, conversation.id);
    wire.customs = [...wire.customs, messageSignature(message)];
  }, BACKGROUND_CONTEXT);
}

/** 复制条目时 head / edits 里的旧 id → 新 id；指向复制范围之外的 id 抛错（宁可分支失败，不带一份断头的历史） */
function remap(ids: Map<number, EntryId>, id: EntryId, what: string): EntryId {
  const mapped = ids.get(id);
  if (mapped === undefined) throw new Error(`${what} ${id} points outside the copied history`);
  return mapped;
}

function remapEdits(ids: Map<number, EntryId>, edits: readonly ContextEdit[] | undefined): ContextEdit[] | undefined {
  if (edits === undefined) return undefined;
  return edits.map((edit) => ({ ...edit, target: remap(ids, edit.target, "context edit target") }));
}

/** 复制范围里的用量（旧内核在分支出来的新本子上算 getSessionStats 的口径：回答与工具结果自带的 usage） */
function copiedUsage(entries: readonly EntryRecord[]): ReturnType<typeof legacyUsageOf> {
  return legacyUsageOf(entries.flatMap((entry) => (entry.model ?? []).map((message: Message) => ({ type: "message", message }))));
}

/**
 * 分支：源会话裁点（锚点必须是回答，连带它的工具结果）之前的全部可见条目，原样复制进目标库的一条新会话。
 * 一次提交：索引、历史、跨轮账（裁点那一刻的）与全部条目同落——崩溃在中途，目标库里没有半份。
 */
export async function branchSession(input: {
  source: Harness;
  sourceSessionId: string;
  roles: readonly ("user" | "assistant")[];
  target: Harness;
  sessionId: string;
}): Promise<void> {
  const conversation = await indexedConversation(input.source, input.sourceSessionId);
  const entries: EntryRecord[] = [];
  await eachEntry(conversation, (entry) => entries.push(entry));
  const cut = Number(planBranchCut(entries.map(cutEntryOf), input.roles));
  const copied = entries.slice(0, entries.findIndex((entry) => entry.id === cut) + 1);
  const wire = await input.source.snapshotAsOf(WireDoc, conversation.id, cut as EntryId, BACKGROUND_CONTEXT);
  const usage = copiedUsage(copied);
  await input.target.createConversation(
    {
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        const index = await tx.doc(SessionIndexDoc);
        if (index.sessions[input.sessionId] !== undefined) throw new Error(`session ${input.sessionId} already exists in the target library`);
        await adopt(tx, input.sessionId, id, true);
        const state = await tx.doc(WireDoc, id);
        if (wire !== undefined) {
          state.imageMark = wire.imageMark === null ? null : { ...wire.imageMark };
          state.imageRefs = wire.imageRefs.map(([hash, path]) => [hash, path]);
          state.memory = wire.memory.map(([at, block]) => [at, block]);
          state.customs = [...wire.customs];
          if (wire.legacyTools !== undefined) state.legacyTools = JSON.parse(JSON.stringify(wire.legacyTools)) as JsonObject[];
        }
        state.legacyUsage = usage;
        const ids = new Map<number, EntryId>();
        for (const entry of copied) {
          const head = entry.head === undefined ? undefined : entry.head === entry.id ? ("self" as const) : remap(ids, entry.head, "head");
          const edits = remapEdits(ids, entry.edits);
          const record = await tx.appendEntry(id, {
            kind: entry.kind,
            ...(entry.model === undefined ? {} : { model: entry.model }),
            ...(entry.data === undefined ? {} : { data: entry.data }),
            ...(head === undefined ? {} : { head }),
            ...(edits === undefined ? {} : { edits }),
          });
          ids.set(entry.id, record.id);
        }
      },
    },
    BACKGROUND_CONTEXT,
  );
}
