/**
 * 新内核的视图适配层：把 durable 的会话视图（ConversationView：条目窗口 + pi.live 文档）与进程内的工具钩子，
 * 翻成旧内核那套 pi AgentSession 事件（message_start / update / end、tool_execution_start / update / end），
 * 再交给**同一个** TranscriptAdapter 产出转录 progress——renderer 收到的事件与旧内核同形，它不认识 durable。
 * 不 import electron，`node --test` 直接测。
 *
 * 为什么在这一层「合成」pi 事件而不是另写一个 durable → progress 的翻译：progress 的全部细节（id 铸造、
 * 终态判定、genMs、整条重发时截到已发增量、工具结果的形状校验）都在 TranscriptAdapter 里，被旧内核磨过；
 * 另写一份就是两份会漂的实现。
 *
 * 来源与时序（durable 1.5.2 源码核过）：
 * - 流式回答：`pi.live.generation.message` 是节流提交的半截回答（settings.progress.partialIntervalMs）。
 *   每次变了，逐块和上一次比：新块先发一个 `*_start`（非增量帧，整条重发），文字 / 思考块长出来的部分发
 *   `*_delta`，工具调用块的参数变了发非增量帧。第一次看到它时先发一条空内容的 message_start——
 *   TranscriptAdapter 记「已发出的增量」从 0 起，否则整条重发时会把已有的字截掉。
 * - 回答落定：`pi.assistant` 条目追加 → message_end（终态以条目里的消息为准）。
 * - 工具：开始由 beforeTool 钩子报（按调用顺序，闸门之前——与 pi 的 tool_execution_start 同一个时点）；
 *   流式输出由工具的 onUpdate 报（进程内，与旧内核同一个回调）；结束看 `pi.tool-result` 条目
 *   （闸门拒绝、参数不对、被停的结果也是条目，钩子没报开始的先补一个开始）。
 * - 用户消息：开轮时我们自己回显（与旧内核同一个 userPrompt），对应的 `pi.user` 条目按原文对账丢掉；
 *   对不上的（父会话插话 steer 被放进来）当场显形——旧内核订阅里「迟到显形」的同一条规则。
 * - 重试：`generation.retry` 出现 → retry 事件（前几次不进界面，同 retryVisibleToUi）；新的一次尝试开跑 → 清掉。
 * - 压缩：阻塞式压缩（`pi.live.compactions` 里 blocking 的）进行时 phase 报 compaction，压完回 turn；
 *   `pi.compaction` 条目追加 → 交给调用方发界碑。
 */
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import { splitEchoBlocks } from "../shared/prompt-attachments.ts";
import { RETRY_MAX_ATTEMPTS, retryVisibleToUi } from "./retry-policy.ts";
import type { AdaptableEvent, TranscriptAdapter } from "./transcript-adapter.ts";
import { INTERRUPTED_BY_CRASH } from "./kernel-turn.ts";

/** 视图适配层要的外部能力 */
export interface KernelViewHooks {
  /** 发给主进程的事件（progress / retry / phase） */
  send(event: AgentEvent): void;
  now(): number;
  /** 一条回答落定（推用量快照用） */
  assistantEnd?(message: AssistantMessage): void;
  /** 一个工具调用落定（文件快照跟踪读「改之后」用） */
  toolEnd?(callId: string): void;
  /** 压缩摘要条目落进会话（发界碑用） */
  compactionPlaced?(entry: EntryRecord): void;
  /** 应用正在正常退出：这时被停下的半截回答不落终态帧（见 endAssistant）；缺席 = 不在退出 */
  quitting?(): boolean;
  /** 一条没回显过的 user 条目显出来了（插话放进上下文的那一刻；用户插话据此回 placed） */
  userShown?(text: string): void;
}

type BlockState = { type: string; length: number; args: string };

const LIVE = "pi.live";

function textOf(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export class KernelView {
  private readonly sessionId: string;
  private readonly adapter: TranscriptAdapter;
  private readonly hooks: KernelViewHooks;
  /** 窗口里已经处理过的最新条目 id（attach 时为当时最新的那条：之前的不重放） */
  private lastEntry = 0;
  /** 正在流式的那次尝试；null = 不在流式中 */
  private streaming: { attempt: number; blocks: BlockState[]; message: AssistantMessage } | null = null;
  /** 已报过开始的工具调用 */
  private readonly startedTools = new Set<string>();
  /** 各工具调用的入参（结束帧要它；钩子没报开始时从回答里取） */
  private readonly toolArgs = new Map<string, { name: string; args: unknown }>();
  /** 本地回显过的用户消息原文（对账用） */
  private readonly echoed = new Set<string>();
  /** 上一次报出去的重试（尝试号）；null = 没有 */
  private retryShown: number | null = null;
  /** 阻塞式压缩进行中（phase compaction） */
  private compacting = false;
  /** 这一轮是不是在跑（phase turn 之后）：压缩结束回 turn 只在轮里做 */
  turnActive = false;
  /** 本轮见过回答开始（压缩界碑的时间戳规则、turn-failure 用） */
  sawAssistant = false;
  /** 本轮重试过几次（最后一次尝试号 - 1） */
  retries = 0;

  constructor(sessionId: string, adapter: TranscriptAdapter, hooks: KernelViewHooks) {
    this.sessionId = sessionId;
    this.adapter = adapter;
    this.hooks = hooks;
  }

  /** attach 之前就到了的最新一帧（durable 的 observer 可能先于 observeConversation 的 promise 交帧） */
  private pending: ConversationView | null = null;
  private attached = false;

  /**
   * 接上视图：只记下当时的最新条目，之前的都不重放；attach 之前到的那一帧随后补上。
   * 例外：会话末尾那几条「被崩溃打断」的工具结果——kernel 重开库时才写下（那时没有视图在看），界面上那次调用
   * 一直没有结果；这里补发它们的结束帧，界面上那一步显示成失败、展开看得到为什么（续跑 / 点「继续」之后看得出哪一步被打断过）。
   */
  attach(value: ConversationView): void {
    const newest = value.entries.at(-1);
    this.lastEntry = newest === undefined ? (value.before ?? 0) : newest.id;
    this.attached = true;
    this.replayCrashResults(value.entries);
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) this.advance(pending);
  }

  private replayCrashResults(entries: readonly EntryRecord[]): void {
    const tail: ToolResultMessage[] = [];
    let at = entries.length - 1;
    for (; at >= 0; at--) {
      const entry = entries[at];
      const message = entry?.model?.[0] as Message | undefined;
      if (entry?.kind !== "pi.tool-result" || message?.role !== "toolResult") break;
      tail.unshift(message);
    }
    const crashed = tail.filter((message) => message.isError && textOf(message.content).startsWith(INTERRUPTED_BY_CRASH));
    if (crashed.length === 0) return;
    const assistant = entries[at]?.model?.[0] as Message | undefined;
    if (assistant?.role === "assistant") {
      for (const block of assistant.content) if (block.type === "toolCall") this.toolArgs.set(block.id, { name: block.name, args: block.arguments });
    }
    for (const message of crashed) this.endTool(message);
  }

  /** 我们自己回显过的一句（随后它的 pi.user 条目对账丢掉） */
  noteEcho(text: string): void {
    this.echoed.add(text);
  }

  /** 开轮回显用户这一句（旧内核 echoAndPrompt 的同一个 userPrompt，经同一个 adapter：同一套 id 铸造） */
  userPrompt(...args: Parameters<TranscriptAdapter["userPrompt"]>): ReturnType<TranscriptAdapter["userPrompt"]> {
    return this.adapter.userPrompt(...args);
  }

  /** 视图的下一个版本（durable 的 observer.advance：只记、不 await、不抛） */
  advance(value: ConversationView): void {
    if (!this.attached) {
      this.pending = value;
      return;
    }
    try {
      this.advanceEntries(value);
      this.advanceLive(value.docs[LIVE] as LiveState | undefined);
    } catch (cause) {
      console.error("[kernel-view] 视图适配失败（这一帧丢掉）", this.sessionId, cause);
    }
  }

  /** beforeTool：一个工具调用要开始了（闸门之前） */
  toolStart(callId: string, name: string, args: unknown): void {
    if (this.startedTools.has(callId)) return;
    this.startedTools.add(callId);
    this.toolArgs.set(callId, { name, args });
    this.apply({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
  }

  /** 工具的流式输出（pi 工具的 onUpdate，partialResult 与旧内核同形） */
  toolUpdate(callId: string, name: string, partialResult: unknown): void {
    if (!this.startedTools.has(callId)) return;
    const known = this.toolArgs.get(callId);
    this.apply({ type: "tool_execution_update", toolCallId: callId, toolName: name, args: known?.args, partialResult });
  }

  private apply(event: AdaptableEvent): void {
    if (event.type === "message_start" && event.message.role === "assistant") this.sawAssistant = true;
    for (const progress of this.adapter.apply(event)) this.hooks.send({ type: "progress", sessionId: this.sessionId, progress });
  }

  private advanceEntries(value: ConversationView): void {
    for (const entry of value.entries) {
      if (entry.id <= this.lastEntry) continue;
      this.lastEntry = entry.id;
      this.onEntry(entry);
    }
  }

  private onEntry(entry: EntryRecord): void {
    const message = entry.model?.[0] as Message | undefined;
    if (entry.kind === "pi.compaction") {
      this.hooks.compactionPlaced?.(entry);
      return;
    }
    if (message === undefined) return;
    if (entry.kind === "pi.assistant" && message.role === "assistant") {
      this.endAssistant(message);
      return;
    }
    if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
      this.endTool(message);
      return;
    }
    if (message.role === "user" && (entry.kind === "pi.user" || !entry.kind.startsWith("pi."))) {
      const text = textOf(message.content);
      if (this.echoed.delete(text)) return;
      if (text === "") return;
      for (const progress of this.adapter.userPrompt(splitEchoBlocks(text))) {
        this.hooks.send({ type: "progress", sessionId: this.sessionId, progress });
      }
      this.hooks.userShown?.(text);
    }
  }

  private endAssistant(message: AssistantMessage): void {
    // 应用正常退出时流到一半被停下的回答：不发终态帧（落盘只收终态帧，重启后界面上就没有它），与模型一致——
    // 下一次请求里没有这半截（durable 把被停的半截记成 aborted 条目，发给模型时滤掉）。与 kernel 被杀那一格同样：
    // 清掉 + 「继续」。用户自己点停止的半截照旧落盘（旧内核也留着它），只有退出这一格不同。
    if (message.stopReason === "aborted" && this.hooks.quitting?.() === true) {
      this.streaming = null;
      return;
    }
    if (this.streaming === null) this.apply({ type: "message_start", message: { ...message, content: [] } });
    this.streaming = null;
    for (const block of message.content) {
      if (block.type === "toolCall") this.toolArgs.set(block.id, { name: block.name, args: block.arguments });
    }
    this.apply({ type: "message_end", message });
    this.hooks.assistantEnd?.(message);
  }

  private endTool(message: ToolResultMessage): void {
    if (!this.startedTools.has(message.toolCallId)) {
      const known = this.toolArgs.get(message.toolCallId);
      this.toolStart(message.toolCallId, message.toolName, known?.args ?? {});
    }
    this.startedTools.delete(message.toolCallId);
    this.toolArgs.delete(message.toolCallId);
    this.apply({
      type: "tool_execution_end",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      result: { content: message.content, ...(message.details === undefined ? {} : { details: message.details }) },
      isError: message.isError,
    });
    this.hooks.toolEnd?.(message.toolCallId);
  }

  private advanceLive(live: LiveState | undefined): void {
    const generation = live?.generation;
    // 重试：等下一次尝试时报（尝试号 = durable 的 attempt - 1，与 pi 的 auto_retry_start 同口径：第一次重试是 1）
    const retry = generation?.retry;
    if (retry !== undefined && generation !== undefined) {
      const attempt = Math.max(1, generation.attempt - 1);
      if (this.retryShown !== attempt) {
        this.retryShown = attempt;
        this.retries = attempt;
        // 上一次尝试流到一半就失败了：按 pi 的样子给它一个 error 终态（旧内核这里先有一条 error 回答的 message_end）
        if (this.streaming !== null) {
          this.apply({ type: "message_end", message: { ...this.streaming.message, stopReason: "error", errorMessage: retry.error } });
          this.streaming = null;
        }
        if (retryVisibleToUi(attempt)) {
          const now = this.hooks.now();
          this.hooks.send({
            type: "retry",
            sessionId: this.sessionId,
            status: { attempt, maxAttempts: RETRY_MAX_ATTEMPTS, delayMs: Math.max(0, retry.at - now), startedAt: now, errorMessage: retry.error },
          });
        }
      }
    } else if (this.retryShown !== null && generation?.message !== undefined) {
      // 新的一次尝试开跑：清掉重试槽、回 turn（pi 在重试开跑时再发一次 agent_start，旧内核翻成 phase turn）
      this.retryShown = null;
      this.hooks.send({ type: "retry", sessionId: this.sessionId, status: null });
      if (this.turnActive) this.hooks.send({ type: "phase", sessionId: this.sessionId, phase: "turn" });
    }
    // 阻塞式压缩（生成在等它）：phase compaction；压完回 turn
    const blocking = (live?.compactions ?? []).some((status) => status.blocking);
    if (blocking !== this.compacting) {
      this.compacting = blocking;
      if (this.turnActive) this.hooks.send({ type: "phase", sessionId: this.sessionId, phase: blocking ? "compaction" : "turn" });
    }
    const partial = generation?.message as AssistantMessage | undefined;
    if (partial === undefined || generation === undefined) return;
    this.advancePartial(generation.attempt, partial);
  }

  private advancePartial(attempt: number, partial: AssistantMessage): void {
    if (this.streaming === null || this.streaming.attempt !== attempt) {
      this.streaming = { attempt, blocks: [], message: partial };
      this.apply({ type: "message_start", message: { ...partial, content: [] } });
    }
    const state = this.streaming;
    state.message = partial;
    partial.content.forEach((block, index) => {
      const previous = state.blocks[index];
      if (previous === undefined || previous.type !== block.type) {
        state.blocks[index] = { type: block.type, length: 0, args: "" };
        const kind = block.type === "toolCall" ? "toolcall" : block.type;
        this.apply({ type: "message_update", message: partial, assistantMessageEvent: { type: `${kind}_start`, contentIndex: index } });
      }
      const current = state.blocks[index] as BlockState;
      if (block.type === "text" || block.type === "thinking") {
        const text = block.type === "text" ? block.text : block.thinking;
        if (text.length > current.length) {
          const delta = text.slice(current.length);
          current.length = text.length;
          this.apply({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: block.type === "text" ? "text_delta" : "thinking_delta", contentIndex: index, delta },
          });
        }
        return;
      }
      if (block.type === "toolCall") {
        const args = JSON.stringify(block.arguments ?? {});
        if (args !== current.args) {
          current.args = args;
          this.apply({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_update", contentIndex: index } });
        }
      }
    });
  }
}
