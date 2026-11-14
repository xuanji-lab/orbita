/**
 * 新内核的逐请求注入（wire-only：只改发给模型的那份，库里的转录不动）——旧内核四个 `context` 扩展的对位：
 * 图片字节预算 → 压缩后挂目标账 → 记忆附件 → 用户情境，**顺序、算法、胶水都是旧内核用的那几个函数**
 * （image-byte-budget.ts 的 applyImageBudget、goal-compaction.ts、memory-inject.ts、user-context.ts）。
 *
 * 两个内核在这一层只有一处形状差：旧内核的 context 事件里是 pi 的 AgentMessage（压缩摘要是
 * `compactionSummary`、扩展消息是 `custom`、分支摘要是 `branchSummary`），convertToLlm 之后才变成 user 消息；
 * durable 的 beforeRequest 里已经全是 pi-ai 的 Message。那几个函数认角色（用户情境只给 `user` 加时间、
 * 目标账只挂在 `compactionSummary` 上），所以先把 durable 的消息**还原成旧内核那时的形状**（liftMessages），
 * 跑同一串变换，再用 pi 同一个 convertToLlm 落回去——两边经过的是同一条变换链。
 *
 * 最后把系统消息折成一条（collapseSystem，pi-ai collapseSystemMessages 的同款）：旧内核的系统提示是 before_agent_start 强制给的整段，
 * pi 在请求前把会话里的系统消息全部折成一条打头（_installAgentForcedPromptProjection）；durable 对支持
 * 「对话中途系统消息」的型号会把段的变化作为中途消息发出去。折掉，两边发出的系统提示都是一整段。
 *
 * 跨轮的账（图片水位与引用、各轮记忆块、迁移来的扩展消息指纹）旧内核记在 pi 本子的 custom entry 里，
 * 新内核记在会话文档 `orbita.wire` 里。
 */
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { attachGoalLedger, type LedgerAttachCache } from "./goal-compaction.ts";
import { applyImageBudget, hashImage, imageRefPath, type ContextMessage, type TurnImageBudget } from "./image-byte-budget.ts";
import { BRANCH_PREFIX, BRANCH_SUFFIX, COMPACTION_PREFIX, COMPACTION_SUFFIX } from "./legacy-migrate.ts";
import { attachMemoryBlocks, type TurnMemoryAttach } from "./memory-inject.ts";
import { injectUserContext } from "./user-context.ts";

/** 会话文档 `orbita.wire`：逐请求注入的跨轮账（对应旧内核本子里 orbita-image-budget / -refs / memory-attach 三种 custom entry） */
export type WireState = {
  /** 图片字节预算的现行水位；null = 从未触发 */
  imageMark: { cut: number; cutIndex: number } | null;
  /** 图片 hash → 原图引用（与旧内核本子里 orbita-image-refs 记的值同形） */
  imageRefs: [string, string][];
  /** 用户消息时间戳 → 那一轮挂上的记忆块（首次认领时定格，之后逐字节重放） */
  memory: [number, string][];
  /** 迁移来的扩展消息（旧内核的 custom_message / custom 角色 / bashExecution）的指纹：它们在旧内核的 context 里不是 user */
  customs: string[];
};

export const WireDoc = defineDoc<WireState>({
  kind: "orbita.wire",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ imageMark: null, imageRefs: [], memory: [], customs: [] }),
  checkpointWhen: () => true,
});

/** 一条消息的指纹：时间戳 + 第一段文字的开头。迁移时给扩展消息记、请求时据此认回来 */
export function messageSignature(message: { timestamp?: unknown; content?: unknown }): string {
  const content = message.content;
  const first = typeof content === "string" ? content : Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  return `${typeof message.timestamp === "number" ? message.timestamp : "?"}:${typeof first === "string" ? first.slice(0, 64) : ""}`;
}

function soleText(message: Message): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (message.content.length !== 1) return null;
  const [part] = message.content;
  return part !== undefined && part.type === "text" ? part.text : null;
}

/**
 * durable 的消息 → 旧内核 context 事件里的形状：压缩摘要、分支摘要按 pi 固定的包装文字认回来
 * （迁移与 durable 自己的压缩写的是逐字相同的包装），迁移来的扩展消息按指纹认回来。其余原样。
 */
export function liftMessages(messages: readonly Message[], customs: ReadonlySet<string>): ContextMessage[] {
  return messages.map((message) => {
    const text = soleText(message);
    if (text !== null && text.startsWith(COMPACTION_PREFIX) && text.endsWith(COMPACTION_SUFFIX) && text.length >= COMPACTION_PREFIX.length + COMPACTION_SUFFIX.length) {
      const summary = text.slice(COMPACTION_PREFIX.length, text.length - COMPACTION_SUFFIX.length);
      return { role: "compactionSummary", summary, tokensBefore: 0, timestamp: message.timestamp } as unknown as ContextMessage;
    }
    if (text !== null && text.startsWith(BRANCH_PREFIX) && text.endsWith(BRANCH_SUFFIX) && text.length >= BRANCH_PREFIX.length + BRANCH_SUFFIX.length) {
      const summary = text.slice(BRANCH_PREFIX.length, text.length - BRANCH_SUFFIX.length);
      return { role: "branchSummary", summary, fromId: "", timestamp: message.timestamp } as unknown as ContextMessage;
    }
    if (message.role === "user" && customs.size > 0 && customs.has(messageSignature(message))) {
      return { role: "custom", customType: "orbita.legacy", content: message.content, display: false, timestamp: message.timestamp } as unknown as ContextMessage;
    }
    return message as unknown as ContextMessage;
  });
}

/** 一轮的注入状态：开轮时从 `orbita.wire` 读，轮内推进，变化经 conversation.commit 落回去 */
export class TurnWire {
  readonly budget: TurnImageBudget;
  readonly memory: TurnMemoryAttach;
  private readonly customs: Set<string>;
  private readonly ledgerCache: LedgerAttachCache = new Map();
  private readonly timeZone: string;
  private readonly conversation: Conversation;
  private writes: Promise<void>[] = [];

  private constructor(conversation: Conversation, state: WireState, attachmentsDir: string, timeZone: string) {
    this.conversation = conversation;
    this.timeZone = timeZone;
    this.customs = new Set(state.customs);
    this.budget = {
      mark: state.imageMark === null ? null : { ...state.imageMark, replaced: 0, bytesAfter: 0 },
      refs: new Map(state.imageRefs.map(([hash, ref]) => [hash, imageRefPath(attachmentsDir, ref)])),
      pendingRefs: new Map(),
      protectedFloor: Number.MAX_SAFE_INTEGER,
    };
    this.memory = { attached: new Map(state.memory), pending: null };
  }

  /**
   * 时区在 kernel 进程解析一次、本轮内全部消息同一口径（与旧内核 openTurn 同：utility 进程的 Intl 默认时区就是系统时区）。
   */
  static async open(conversation: Conversation, attachmentsDir: string, context: Context): Promise<TurnWire> {
    const state = (await conversation.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(WireDoc, conversation.id))) as WireState, context));
    return new TurnWire(conversation, state, attachmentsDir, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }

  /** 用户附过的图（最近的在前）：slides_insert_image 认 "attached" 用（与旧内核同一个取法） */
  attachedImages(): string[] {
    return [...new Set([...this.budget.refs.values(), ...this.budget.pendingRefs.values()])].reverse();
  }

  /**
   * 本轮附图记账（旧内核 echoAndPrompt + before_agent_start 那两步）：hash 对缩放后的 data 算，值是附件副本路径。
   * 先落账再提交这一句——触发占位替换时这份账已经在库里。
   */
  async notePromptImages(images: readonly { data: string; original?: string }[], attachmentsDir: string, context: Context): Promise<void> {
    for (const image of images) {
      if (image.original === undefined) continue;
      this.budget.pendingRefs.set(hashImage(image.data), imageRefPath(attachmentsDir, image.original));
    }
    if (this.budget.pendingRefs.size === 0) return;
    const pairs = [...this.budget.pendingRefs];
    await this.conversation.commit(async (tx) => {
      (await tx.doc(WireDoc, this.conversation.id)).imageRefs.push(...pairs);
    }, context);
    for (const [hash, path] of pairs) this.budget.refs.set(hash, path);
  }

  private persist(change: (state: WireState) => void, context: Context): void {
    this.writes.push(
      this.conversation.commit(async (tx) => change(await tx.doc(WireDoc, this.conversation.id)), context).catch((cause: unknown) => {
        console.error("[kernel-wire] 注入账落库失败", cause);
      }),
    );
  }

  /**
   * 一次请求的变换（GenerationTask 的 beforeRequest）。`branch` 是叶子路径（pi SessionEntry 形状），目标账要读它。
   * 每一步各自 fail-open（与旧内核各扩展同）：自己的故障不砸掉对话，本步按原样过。
   */
  async transform(messages: readonly Message[], branch: () => readonly unknown[], context: Context): Promise<Message[]> {
    let current = liftMessages(messages, this.customs);
    current =
      applyImageBudget(current, this.budget, (mark) =>
        this.persist((state) => {
          state.imageMark = { cut: mark.cut, cutIndex: mark.cutIndex };
        }, context),
      ) ?? current;
    try {
      current =
        attachGoalLedger(current, branch, this.ledgerCache, (text) =>
          console.error(`[goal-ledger] 压缩摘要后挂账：${text === null ? "账是空的，不挂" : `${text.length} 字`}`),
        ) ?? current;
    } catch (cause) {
      console.error("[goal-ledger] 挂载失败，本轮请求按原样发送", cause);
    }
    try {
      const out = attachMemoryBlocks(current, this.memory);
      const record = out.record;
      if (record !== null) {
        this.persist((state) => {
          state.memory.push([record.at, record.text]);
        }, context);
      }
      current = out.messages ?? current;
    } catch (cause) {
      console.error("[memory] 记忆附件挂载失败，本轮请求按原样发送", cause);
    }
    try {
      current = injectUserContext(current, this.timeZone)?.messages ?? current;
    } catch (cause) {
      console.error("[user-context] 注入失败，本轮请求按原样发送", cause);
    }
    const writes = this.writes;
    this.writes = [];
    await Promise.all(writes);
    return collapseSystem(convertToLlm(current));
  }
}

/** 系统消息折成打头的一条（pi-ai collapseSystemMessages 的消息数组版；那个函数要一个带品牌的 TranscriptContext） */
export function collapseSystem(messages: readonly Message[]): Message[] {
  const head = getCurrentSystemMessage([...messages]);
  const rest = messages.filter((message) => message.role !== "system");
  return head === undefined ? rest : [head, ...rest];
}
