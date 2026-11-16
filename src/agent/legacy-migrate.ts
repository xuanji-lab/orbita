/**
 * 旧会话（pi-coding-agent 的 pi 本子，JSONL v3）→ 新内核（pi-durable）的 entry 序列。
 * 不碰库，`node --test` 直接测：planLegacyMigration 吃整份文本（测试、小本子），planLegacyMigrationFile 两遍流式读文件
 * （迁移用：几百 MB 的本子不整份进内存，草稿逐条交给调用方分批写库）。规则同一个 LegacyPlanner。
 *
 * 迁移的目标是**「下一轮会发给模型的上下文」不变**，不是把本子逐行搬过去：
 *
 * - 只迁**当前分支**（从最后一条沿 parentId 走到根，branchEntries，与 pi 的 buildSessionPath 同一条规则）。
 *   回退 / 重答留下的废枝不迁——旧内核本来也看不见它们；原件原样留着，要翻还在。
 * - 每条 entry 投影成模型消息的规则照抄 pi 1.5.2 的 `sessionEntryToContextMessages` + `convertToLlm`：
 *   user / assistant / toolResult 原样；custom_message、custom 角色、branch_summary、bashExecution
 *   各自变成一条 user 消息（文案与 pi 逐字相同）；compaction 变成 durable 的 `pi.compaction`，
 *   摘要外层的包装文字两边本来就一样（pi 的 COMPACTION_SUMMARY_PREFIX 与 durable 的 SUMMARY_PREFIX 逐字相同）。
 * - 压缩的「从哪条开始保留」（firstKeptEntryId）换成 durable 的 `head`：指向保留的第一条迁过去的 entry。
 *   **不靠 id + 1 猜**（durable 1.5 的 group commit 只保证 id 单调）：调用方在同一次提交里按顺序追加，
 *   用 appendEntry 返回的真 id 回填（headRef 是本序列里的下标）。
 * - 不进上下文的 entry（model_change / thinking_level_change / custom / label / session_info）不迁；
 *   本子里的 system 消息不迁成 entry——新内核每轮自己写 `pi.system`（提示词与工具清单）；但它们回放出的
 *   「模型此前看到的工具清单与顺序」要带走（plan.wire.legacyTools → 会话文档 orbita.wire），新内核迁来后的第一个
 *   请求按它排工具，否则会话中途加过工具的旧会话，迁来后工具顺序变了、提示缓存从头失效一次。
 * - 认不出的东西（context_edit、未来版本的新 entry 类型、未知角色）**整条会话不迁**，如实报原因：
 *   半份上下文比没迁更糟——模型会在缺了一块的历史上接着干。
 */
import type { Message, Tool, UserMessage } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { BookEntry } from "./agent-shapes.ts";
import { createReadStream } from "node:fs";
import { branchEntries, parsePiBook, PI_BOOK_VERSION, type PiBookEntry } from "../main/session/pi-book.ts";
import { readImageBudgetBook } from "./image-byte-budget.ts";
import { memoryAttachments } from "./memory-inject.ts";

/** pi 的 COMPACTION_SUMMARY_PREFIX / SUFFIX（coding-agent 1.5.2 core/messages.js，durable compaction.js 同文） */
export const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUFFIX = "\n</summary>";
/** pi 的 BRANCH_SUMMARY_PREFIX / SUFFIX（同上；注意后缀前没有换行，照抄） */
export const BRANCH_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export const BRANCH_SUFFIX = "</summary>";

/** durable 内建 entry 的 kind（pi-durable entries.js），以及旧内核独有的两种投影 */
export const LEGACY_KINDS = {
  user: "pi.user",
  assistant: "pi.assistant",
  toolResult: "pi.tool-result",
  compaction: "pi.compaction",
  /** pi 的 custom_message / custom 角色 / bashExecution：进上下文的扩展消息 */
  custom: "orbita.legacy-custom",
  branchSummary: "orbita.legacy-branch-summary",
} as const;

/** 一条要追加的 entry。`headRef` 只有压缩有：本序列里保留的第一条的下标，"self" = 它自己（保留段为空）。 */
export interface LegacyDraft {
  kind: string;
  model: Message[];
  data?: { reason: "threshold" } | { diagnostics: [] } | { customType: string | null; display: boolean } | { legacyId: string };
  headRef?: number | "self";
}

/**
 * 逐请求注入的跨轮账：旧内核记在本子 custom entry 里（不进上下文、不迁成 entry），新内核记在会话文档 orbita.wire。
 * 读法就是旧内核开轮时读本子的那两个函数（readImageBudgetBook / memoryAttachments，同一条当前分支）。
 */
export interface LegacyWireSeed {
  imageMark: { cut: number; cutIndex: number } | null;
  imageRefs: [string, string][];
  memory: [number, string][];
  /**
   * 当前分支上 system 记录回放出的工具声明（pi-ai 的 getCurrentTools，旧内核 _restoreToolsFromTranscript 同一个函数、
   * 同一组记录：分支上全部 system 消息，压缩之前的也算）。没有 system 记录 = 空。
   */
  legacyTools: Tool[];
  /**
   * 旧本子的用量累计：与旧内核 getSessionStats 同一个口径（本子**全部** entry——含废枝——里回答与工具结果的 usage、
   * 压缩 / 分支摘要的 usage、单独的 usage 记录）。新内核的用量 = 它 + 迁来之后 durable 自己记的（pi.usage），
   * 迁移不往 pi.usage 里补账，不带走这份就会少算迁移之前的全部花费。
   */
  legacyUsage: LegacyUsage;
}

/** 用量累计（token 四项 + 花费） */
export interface LegacyUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** 旧内核 getSessionStats 的累计口径（pi-coding-agent agent-session.js 的同名函数逐条照抄判定） */
export function legacyUsageOf(entries: readonly { type: string }[]): LegacyUsage {
  const total: LegacyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const add = (usage: unknown): void => {
    if (typeof usage !== "object" || usage === null) return;
    const value = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } };
    const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    total.input += num(value.input);
    total.output += num(value.output);
    total.cacheRead += num(value.cacheRead);
    total.cacheWrite += num(value.cacheWrite);
    total.cost += num(value.cost?.total);
  };
  for (const entry of entries) {
    const record = entry as { type: string; usage?: unknown; message?: { role?: unknown; usage?: unknown } };
    if (record.type === "usage") add(record.usage);
    else if ((record.type === "branch_summary" || record.type === "compaction") && record.usage !== undefined) add(record.usage);
    if (record.type !== "message") continue;
    if (record.message?.role === "toolResult" || record.message?.role === "assistant") add(record.message.usage);
  }
  return total;
}

export interface LegacyPlan {
  /** 本子头里的会话 id：pi 拿它当 provider 的 sessionId（提示缓存亲和），迁过去接着用 */
  providerSessionId: string | null;
  cwd: string;
  drafts: LegacyDraft[];
  /** 当前分支上跳过的 entry 计数（按类型），给报告与排障 */
  skipped: Record<string, number>;
  /** 当前分支之外（废枝）的 entry 数 */
  offBranch: number;
  wire: LegacyWireSeed;
}

export type LegacyPlanResult = { ok: true; plan: LegacyPlan } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampOf(entry: PiBookEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function userText(text: string, timestamp: number): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

/** pi 的 bashExecutionToText（coding-agent 1.5.2 core/messages.js），逐字照抄 */
function bashExecutionText(message: Record<string, unknown>): string {
  let text = `Ran \`${String(message["command"])}\`\n`;
  if (typeof message["output"] === "string" && message["output"] !== "") {
    text += `\`\`\`\n${message["output"]}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  const exitCode = message["exitCode"];
  if (message["cancelled"] === true) {
    text += "\n\n(command cancelled)";
  } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    text += `\n\nCommand exited with code ${String(exitCode)}`;
  }
  if (message["truncated"] === true && typeof message["fullOutputPath"] === "string" && message["fullOutputPath"] !== "") {
    text += `\n\n[Output truncated. Full output: ${message["fullOutputPath"]}]`;
  }
  return text;
}

/** custom 内容：字符串包成一个 text 块，数组原样（pi 的 convertToLlm 同款） */
function customContent(content: unknown): UserMessage["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as UserMessage["content"]) : [];
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * 一条 message entry → 草稿（null = 不进上下文，计入 skipped）。抛错 = 认不出，整条会话不迁。
 * 空 content 补成空数组 / 空串（pi 的 sessionEntryToContextMessages 同款防御）。
 */
function messageDraft(entry: PiBookEntry, skipped: Record<string, number>): LegacyDraft | null {
  const raw = entry.message;
  if (!isRecord(raw)) throw new Error(`entry ${entry.id} has no message`);
  const role = raw["role"];
  const message = raw["content"] == null && (role === "user" || role === "assistant" || role === "toolResult") ? { ...raw, content: [] } : raw;
  // 本子是 pi 写的 Message（JSON 往返过），按 pi-ai 的形状收下——与 pi 自己读本子时同样不做逐字段校验
  if (role === "user") return { kind: LEGACY_KINDS.user, model: [message as unknown as Message] };
  if (role === "assistant") return { kind: LEGACY_KINDS.assistant, model: [message as unknown as Message] };
  if (role === "toolResult") {
    return { kind: LEGACY_KINDS.toolResult, model: [message as unknown as Message], data: { diagnostics: [] } };
  }
  if (role === "system") {
    bump(skipped, "system");
    return null;
  }
  const timestamp = typeof message["timestamp"] === "number" ? message["timestamp"] : timestampOf(entry);
  if (role === "custom") {
    return {
      kind: LEGACY_KINDS.custom,
      model: [{ role: "user", content: customContent(message["content"]), timestamp }],
      data: { customType: typeof message["customType"] === "string" ? message["customType"] : null, display: message["display"] === true },
    };
  }
  if (role === "bashExecution") {
    if (message["excludeFromContext"] === true) {
      bump(skipped, "bashExecution(excluded)");
      return null;
    }
    return { kind: LEGACY_KINDS.custom, model: [userText(bashExecutionText(message), timestamp)], data: { customType: "bashExecution", display: true } };
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    // 只由 entry 派生、不该以 message 形式出现在本子里；出现了就是没见过的写法
    throw new Error(`entry ${entry.id} stores a ${String(role)} message`);
  }
  throw new Error(`entry ${entry.id} has an unknown role ${JSON.stringify(role)}`);
}

/** 不进上下文、可以安全略过的 entry 类型（pi 1.5.2 的 sessionEntryToContextMessages 对它们返回 []） */
const OUT_OF_CONTEXT = new Set(["model_change", "thinking_level_change", "custom", "label", "session_info"]);

/**
 * 逐条规划当前分支上的 entry（按分支顺序 push）：产出草稿，顺带记下读账要的那几样（分支上的 custom 条目、system 消息）。
 * 整份读（planLegacyMigration）与流式读（planLegacyMigrationFile）共用它，规则只有一份。
 */
class LegacyPlanner {
  readonly skipped: Record<string, number> = {};
  /** 已产出的草稿条数 */
  private count = 0;
  /** 本子 entry id → 它之后（含它）第一条迁过去的草稿下标；压缩的保留起点按它查 */
  private readonly firstDraftAtOrAfter = new Map<string, number>();
  private pendingIds: string[] = [];
  /** 分支上的 custom 条目（图片水位、图片引用、记忆块；都很小） */
  private readonly customs: PiBookEntry[] = [];
  /** 分支上的 system 消息（回放模型此前看到的工具清单） */
  private readonly systems: Message[] = [];

  /** 一条分支上的 entry → 草稿（null = 不进上下文）。抛错 = 认不出，整条会话不迁 */
  push(entry: PiBookEntry): LegacyDraft | null {
    this.pendingIds.push(entry.id);
    if (entry.type === "custom") this.customs.push(entry);
    if (entry.type === "message") {
      const message = entry.message as { role?: unknown } | undefined;
      if (message?.role === "system") this.systems.push(message as unknown as Message);
    }
    let draft: LegacyDraft | null = null;
    if (entry.type === "message") {
      draft = messageDraft(entry, this.skipped);
    } else if (entry.type === "custom_message") {
      draft = {
        kind: LEGACY_KINDS.custom,
        model: [{ role: "user", content: customContent((entry as unknown as Record<string, unknown>)["content"] ?? []), timestamp: timestampOf(entry) }],
        data: {
          customType: typeof (entry as unknown as Record<string, unknown>)["customType"] === "string" ? String((entry as unknown as Record<string, unknown>)["customType"]) : null,
          display: (entry as unknown as Record<string, unknown>)["display"] === true,
        },
      };
    } else if (entry.type === "branch_summary") {
      const summary = (entry as unknown as Record<string, unknown>)["summary"];
      if (typeof summary === "string" && summary !== "") {
        draft = { kind: LEGACY_KINDS.branchSummary, model: [userText(BRANCH_PREFIX + summary + BRANCH_SUFFIX, timestampOf(entry))], data: { legacyId: entry.id } };
      } else {
        bump(this.skipped, "branch_summary(empty)");
      }
    } else if (entry.type === "compaction") {
      const record = entry as unknown as Record<string, unknown>;
      const summary = typeof record["summary"] === "string" ? record["summary"] : "";
      const firstKept = typeof record["firstKeptEntryId"] === "string" ? record["firstKeptEntryId"] : null;
      // 保留段 = 当前分支上 firstKept 到这条压缩之间的 entry；firstKept 不在这之前的分支上 = 保留段为空（pi 同款）
      const keptIndex = firstKept === null ? undefined : this.firstDraftAtOrAfter.get(firstKept);
      // 保留段里一条可迁的都没有（只有 model_change 之类）：起点落到压缩自己
      const headRef: number | "self" =
        keptIndex === undefined || keptIndex >= this.count || (firstKept !== null && this.pendingIds.includes(firstKept)) ? "self" : keptIndex;
      draft = {
        kind: LEGACY_KINDS.compaction,
        model: [userText(COMPACTION_PREFIX + summary + COMPACTION_SUFFIX, timestampOf(entry))],
        data: { reason: "threshold" },
        headRef,
      };
      if (record["systemMessage"] !== undefined) bump(this.skipped, "compaction.systemMessage");
    } else if (entry.type === "context_edit") {
      throw new Error(`entry ${entry.id} is a context_edit (not supported by the migration yet)`);
    } else if (OUT_OF_CONTEXT.has(entry.type)) {
      bump(this.skipped, entry.type);
    } else {
      throw new Error(`entry ${entry.id} has an unknown type ${JSON.stringify(entry.type)}`);
    }
    if (draft !== null) {
      for (const id of this.pendingIds) this.firstDraftAtOrAfter.set(id, this.count);
      this.pendingIds = [];
      this.count++;
    }
    return draft;
  }

  /** 逐请求注入的跨轮账（旧内核开轮时读本子的同两个函数，同一条分支上的 custom 条目） */
  wire(legacyUsage: LegacyUsage): LegacyWireSeed {
    // 本子 entry 与 pi 的 BookEntry 同形（pi 写的 JSONL 行），旧内核读账的函数直接认
    const branch = this.customs as unknown as BookEntry[];
    const budget = readImageBudgetBook(branch);
    return {
      imageMark: budget.mark === null ? null : { cut: budget.mark.cut, cutIndex: budget.mark.cutIndex },
      imageRefs: [...budget.refs],
      memory: [...memoryAttachments(branch)],
      legacyTools: getCurrentTools(this.systems),
      legacyUsage,
    };
  }
}

/**
 * 解析 + 规划（整份文本在内存里）。不抛错：认不出的本子返回 `{ ok: false, reason }`，reason 是给人看的一句话。
 * 迁移走流式的 planLegacyMigrationFile；这一份给测试与小本子用，规则同一个 LegacyPlanner。
 */
export function planLegacyMigration(raw: string): LegacyPlanResult {
  let book;
  try {
    book = parsePiBook(raw);
  } catch (error) {
    return { ok: false, reason: `pi 本子读不出来：${error instanceof Error ? error.message : String(error)}` };
  }
  const path = branchEntries(book.entries);
  const planner = new LegacyPlanner();
  const drafts: LegacyDraft[] = [];
  try {
    for (const entry of path) {
      const draft = planner.push(entry);
      if (draft !== null) drafts.push(draft);
    }
  } catch (error) {
    return { ok: false, reason: `pi 本子里有认不出的内容：${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    ok: true,
    plan: {
      wire: planner.wire(legacyUsageOf(book.entries)),
      providerSessionId: book.header.id,
      cwd: book.header.cwd,
      drafts,
      skipped: planner.skipped,
      offBranch: book.entries.length - path.length,
    },
  };
}

/** 流式规划的结局：草稿已经一条条交给了 onDraft，这里只剩汇总 */
type LegacyStreamResult =
  | { ok: true; providerSessionId: string | null; cwd: string; drafts: number; skipped: Record<string, number>; offBranch: number; wire: LegacyWireSeed; bytes: number }
  | { ok: false; reason: string };

/**
 * 流式迁移每读这么多原文收一次垃圾。大行（图片 base64、长工具结果）解析出的字符串直接进大对象区，V8 要等老生代
 * 涨到阈值才做完整 GC——不管的话 139 MB 的本子迁移时垃圾能堆到 300 MB 以上（实测），峰值就压不到本子大小的 2 倍。
 */
const GC_EVERY_BYTES = 4 * 1024 * 1024;

/** 一行在文件里的位置（字节） */
interface LineSpan {
  ordinal: number;
  start: number;
  end: number;
}

/**
 * 逐行读一个文件（按 `\n` 切字节、逐行解码），不把整份读进内存。visit 拿到行文本与位置；
 * wanted 给了时只解码这些行号（第二遍只要分支上的行）。
 */
async function eachLine(file: string, visit: (text: string, span: LineSpan) => Promise<void> | void, wanted?: ReadonlySet<number>): Promise<number> {
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  // 跨块的半行：攒成片段表、遇到换行才拼一次（大行一块块累加再 concat 会反复拷贝）
  let parts: Buffer[] = [];
  let partsLength = 0;
  let offset = 0;
  // 行号对两遍读都一样：按 \n 切出的每一行（含空行与坏行）都占一个号
  let ordinal = 0;
  const emit = async (pieces: Buffer[], length: number, start: number): Promise<void> => {
    const at = ordinal++;
    if (wanted !== undefined && !wanted.has(at)) return;
    const line = pieces.length === 1 ? (pieces[0] ?? Buffer.alloc(0)) : Buffer.concat(pieces, length);
    await visit(line.toString("utf8"), { ordinal: at, start, end: start + length });
  };
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
      const piece = chunk.subarray(from, at);
      const start = offset + from - partsLength;
      await emit([...parts, piece], partsLength + piece.length, start);
      parts = [];
      partsLength = 0;
      from = at + 1;
    }
    if (from < chunk.length) {
      parts.push(chunk.subarray(from));
      partsLength += chunk.length - from;
    }
    offset += chunk.length;
  }
  if (partsLength > 0) await emit(parts, partsLength, offset - partsLength);
  return offset;
}

/** 一条本子 body 行的索引（第一遍只留这些，不留内容） */
interface IndexedLine {
  ordinal: number;
  rawId: unknown;
  rawParentId: unknown;
  type: string;
  usage: LegacyUsage;
}

/**
 * 流式规划：两遍读文件，**整份内容从不同时在内存里**。
 * 第一遍：逐行解析，只留每行的 id / parentId / type 与它的用量（旧内核 getSessionStats 数整本本子），找出当前分支；
 * 第二遍：只解析分支上的行，按分支顺序交给 LegacyPlanner，草稿逐条交给 onDraft（调用方分批写进库）。
 * 解析规则与 parsePiBook / branchEntries 一致（坏行跳过、首个 session 行是头、v1 补 id 与线性 parentId 链、v<3 的 hookMessage → custom）。
 * 分支顺序与文件顺序不一致（只可能来自手改的文件）时如实报错不迁——调用方不会拿到半份。
 */
export async function planLegacyMigrationFile(
  file: string,
  onDraft: (draft: LegacyDraft, bytes: number) => Promise<void>,
  /** 每读过约 GC_EVERY_BYTES 原文调一次（kernel 进程里是一次完整 GC，见 kernel-gc.ts）；缺席 = 不调 */
  collect?: () => void,
): Promise<LegacyStreamResult> {
  let sinceCollect = 0;
  const maybeCollect = (bytes: number): void => {
    sinceCollect += bytes;
    if (collect === undefined || sinceCollect < GC_EVERY_BYTES) return;
    sinceCollect = 0;
    collect();
  };
  let head: Record<string, unknown> | null = null;
  const body: IndexedLine[] = [];
  let bytes: number;
  try {
    bytes = await eachLine(file, (text, span) => {
      maybeCollect(span.end - span.start);
      if (text.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      if (head === null && parsed["type"] === "session") {
        head = { id: parsed["id"], cwd: parsed["cwd"], version: parsed["version"] };
        return;
      }
      if (typeof parsed["type"] !== "string") return;
      body.push({ ordinal: span.ordinal, rawId: parsed["id"], rawParentId: parsed["parentId"], type: parsed["type"], usage: legacyUsageOf([parsed as { type: string }]) });
    });
  } catch (error) {
    return { ok: false, reason: `pi 本子读不出来：${error instanceof Error ? error.message : String(error)}` };
  }
  const headRecord: Record<string, unknown> | null = head;
  if (headRecord === null) return { ok: false, reason: "pi 本子读不出来：no session header" };
  const version = typeof headRecord["version"] === "number" && Number.isFinite(headRecord["version"]) ? headRecord["version"] : 1;
  if (version > PI_BOOK_VERSION) return { ok: false, reason: `pi 本子读不出来：session version ${version} is newer than supported (${PI_BOOK_VERSION})` };
  // id / parentId：与 parsePiBook 同一套（v1 补链；没有 id 的行不算 entry）
  const entries: (PiBookEntry & { ordinal: number; usage: LegacyUsage })[] = [];
  let previous: string | null = null;
  body.forEach((line, index) => {
    const id = version < 2 ? `v1-${index}` : typeof line.rawId === "string" && line.rawId !== "" ? line.rawId : null;
    if (id === null) return;
    const parentId = version < 2 ? previous : typeof line.rawParentId === "string" && line.rawParentId !== "" ? line.rawParentId : null;
    previous = id;
    entries.push({ type: line.type, id, parentId, timestamp: "", ordinal: line.ordinal, usage: line.usage });
  });
  const path = branchEntries(entries);
  for (let at = 1; at < path.length; at++) {
    if ((path[at]?.ordinal ?? 0) <= (path[at - 1]?.ordinal ?? 0)) return { ok: false, reason: "pi 本子的当前分支不是按文件顺序写的（手改过？），不迁" };
  }
  const total: LegacyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    total.input += entry.usage.input;
    total.output += entry.usage.output;
    total.cacheRead += entry.usage.cacheRead;
    total.cacheWrite += entry.usage.cacheWrite;
    total.cost += entry.usage.cost;
  }
  const idOf = new Map(path.map((entry) => [entry.ordinal, entry]));
  const planner = new LegacyPlanner();
  let drafts = 0;
  try {
    await eachLine(
      file,
      async (text, span) => {
        const known = idOf.get(span.ordinal);
        if (known === undefined) return;
        maybeCollect(span.end - span.start);
        const line = JSON.parse(text) as Record<string, unknown>;
        const message = line["message"];
        if (version < 3 && line["type"] === "message" && isRecord(message) && message["role"] === "hookMessage") message["role"] = "custom";
        const entry: PiBookEntry = { ...line, type: known.type, id: known.id, parentId: known.parentId, timestamp: typeof line["timestamp"] === "string" ? line["timestamp"] : "" };
        const draft = planner.push(entry);
        if (draft === null) return;
        drafts++;
        await onDraft(draft, span.end - span.start);
      },
      new Set(idOf.keys()),
    );
  } catch (error) {
    return { ok: false, reason: `pi 本子里有认不出的内容：${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    ok: true,
    providerSessionId: typeof headRecord["id"] === "string" && headRecord["id"] !== "" ? headRecord["id"] : null,
    cwd: typeof headRecord["cwd"] === "string" ? headRecord["cwd"] : "",
    drafts,
    skipped: planner.skipped,
    offBranch: entries.length - path.length,
    wire: planner.wire(total),
    bytes,
  };
}
