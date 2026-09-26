/**
 * transcript-adapter —— 把 pi 的 AgentSession 事件流翻成 pi-protocol 的 transcript 协议。
 *
 * 这是整条链路唯一有实质翻译工作的地方（docs/single-agent-guideline.md §三）。
 * 上游给的是 `AgentSessionEvent`（含整条 AssistantMessage 与流式增量），
 * 下游要的是 `TranscriptProgress`（item_started / assistant_delta / item_updated / item_finished），
 * 渲染层用 pi 自带的 `transcript.ts` 归约器消费它——**归约器不是我们写的，也不该我们写**。
 *
 * 为什么要翻：pi-ai 的 Message 没有 id、没有时间戳、没有「流式中/已完成」状态，
 * 而 protocol 的 TranscriptItem 三样都要。id 由本模块铸造并在一条消息的
 * start → update* → end 全程保持不变。
 *
 * 纯模块：不 import electron、不 import 进程相关的东西，可被 `node --test` 直接加载。
 */
import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type {
  AssistantTranscriptItem,
  ModelRef,
  ToolTranscriptItem,
  TranscriptItem,
  TranscriptProgress,
} from "@earendil-works/pi-protocol";

/** 0.84.3 起协议只导出 Schema 常量不导出内容类型——从 TranscriptItem 反推，不为此引 typebox */
type AssistantContent = AssistantTranscriptItem["content"][number];
type UserContent = Extract<TranscriptItem, { role: "user" }>["content"][number];

/** 我们自挂在 assistant item 上的生成时长：不在 pi schema 上，归约器实测原样保留（探针 2026-09-06） */
type WithGenMs = { genMs?: number };

/**
 * 协议把 status 与终态字段绑成固定变体，三个事件槽位各只认一部分：
 * item_updated 不收 user 条目，item_finished 还不收 streaming 条目。
 * 构造函数的返回类型必须与槽位同宽——宽了（泛指 TranscriptItem）对不上窄槽，
 * 窄了丢失不了什么（我们本来就只按分支生产对应变体）。
 */
type StreamingAssistantItem = Extract<AssistantTranscriptItem, { status: "streaming" }>;
type FinalAssistantItem = Exclude<AssistantTranscriptItem, { status: "streaming" }>;
type RunningToolItem = Extract<ToolTranscriptItem, { status: "running" }>;
type FinalToolItem = Exclude<ToolTranscriptItem, { status: "running" }>;

/** 工具结果的内容块。协议里只允许 text 与 image 两种。 */
type ToolContent = ToolTranscriptItem["content"][number];

/** 铸 id 的能力注入进来：测试要可预测的 id，生产用 randomUUID。 */
export interface AdapterDeps {
  newId(): string;
  now(): number;
}

/**
 * 本模块只消费这些事件；其余 AgentSessionEvent 一律忽略（返回空数组）。
 *
 * 三个 `tool_execution_*` 就在 pi 的 `AgentEvent` 里（pi-agent-core `types.d.ts`），
 * `session.subscribe()` 直接拿得到——**不需要写 pi 扩展**。
 * 上游把 result 声明成 `any`；进到我们这里一律收窄成 `unknown`，转换时再逐层验形状。
 */
export type AdaptableEvent =
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: Message; assistantMessageEvent: AssistantStreamEvent }
  | { type: "message_end"; message: Message }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

/** pi-ai AssistantMessageEvent 里我们用得上的分支。 */
export type AssistantStreamEvent =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: string; contentIndex?: number };

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 协议只认 text 与 image；别的形状一律丢弃，不猜。 */
function isToolContent(value: unknown): value is ToolContent {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image") return typeof value.data === "string" && typeof value.mimeType === "string";
  return false;
}

/**
 * pi 的工具产出 → 协议的内容块。
 *
 * 正常路径：pi 给的是 `AgentToolResult`（`{ content: (TextContent|ImageContent)[], details }`），
 * 它的 content 与协议的 content **形状本来就一样**，过一遍类型守卫直接用。
 *
 * 兜底存在的理由：`result` 在上游是 `any`，自定义工具可以返回任何东西。
 * 与其让一条畸形结果把整条 transcript 打断，不如把它序列化成文本留在记录里——
 * **看得到一坨 JSON，好过一条工具调用在记录里没有下文。**
 */
/**
 * 工具的结构化副产品。协议把它定为可选的 JsonValue，不入模型上下文，只给 UI 与日志。
 *
 * **为什么要带它**：pi 的 edit 工具已经把 diff 算好放在这里了
 * （`EditToolDetails { diff, patch, firstChangedLine }`）。丢了它，后面做内联 diff
 * 就得拿旧新内容重算一遍——而旧内容在结果里根本不存在。
 *
 * 不做深度校验：能序列化就带上，不能就丢。details 是锦上添花，
 * 不能为了它把一条本来能记下的工具结果整条弄丢。
 */
function toToolDetails(result: unknown): ToolTranscriptItem["details"] {
  if (!isRecord(result) || !("details" in result)) return undefined;
  const details = result.details;
  if (details === undefined || details === null) return undefined;
  try {
    JSON.stringify(details);
  } catch {
    return undefined;
  }
  return details as ToolTranscriptItem["details"];
}

function toToolContent(result: unknown): ToolContent[] {
  if (isRecord(result) && Array.isArray(result.content)) {
    const blocks = result.content.filter(isToolContent);
    if (blocks.length > 0) return blocks;
  }
  if (typeof result === "string") return [{ type: "text", text: result }];
  if (result === undefined || result === null) return [];
  try {
    return [{ type: "text", text: JSON.stringify(result) ?? "" }];
  } catch {
    // 循环引用之类：宁可记一句「没法显示」，也不要抛异常打断整条链路
    return [{ type: "text", text: "[unserializable tool result]" }];
  }
}

/** pi-ai 的内容块 → protocol 的内容块。字段名不同的只有 toolCall。 */
function toAssistantContent(block: TextContent | ThinkingContent | ToolCall): AssistantContent {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") {
    return block.redacted === undefined
      ? { type: "thinking", thinking: block.thinking }
      : { type: "thinking", thinking: block.thinking, redacted: block.redacted };
  }
  // pi-ai: {id, name, arguments} → protocol: {toolCallId, toolName, input}
  // pi-ai 的 arguments 是 Record<string, any>（上游就宽），协议要 JsonValue——
  // 工具入参本来就是模型产出的 JSON，这一处断言是唯一的形合点
  return {
    type: "toolCall",
    toolCallId: block.id,
    toolName: block.name,
    input: block.arguments as Extract<AssistantContent, { type: "toolCall" }>["input"],
  };
}

function toModelRef(message: AssistantMessage): ModelRef {
  return { provider: message.provider, id: message.model };
}

/**
 * AgentSession 的事件流 → TranscriptProgress 流。
 *
 * 一条 assistant 消息的 id 在 message_start 时铸造，直到 message_end 都不变——
 * 这是增量帧（assistant_delta 带 messageId）能被归约器对上号的前提。
 */
export class TranscriptAdapter {
  private readonly deps: AdapterDeps;
  /** 当前正在流式的 assistant 消息 id；不在流式中时为 null。 */
  private activeAssistantId: string | null = null;
  /** 本条消息的生成起点（message_start 的钟）；落定即清——genMs 的起算点。 */
  private genStart: number | null = null;
  /**
   * 正在执行的工具：toolCallId → 我们铸的 item id 与入参。
   *
   * **为什么要存入参**：`tool_execution_end` 上游只给 `result`，**不再给 `args`**，
   * 而协议的 tool item 要求 input 必填。不在 start 时接住，终态帧就只能编一个空入参。
   */
  private readonly activeTools = new Map<string, { id: string; input: unknown }>();

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  /**
   * 用户提交的 prompt：本地立刻造一条 user item，不等模型回。
   * 块序：文字在前，粘贴块与文件清单（`extras`，prompt-attachments 组装好的带标签
   * 文本）跟在后面，图片殿后——与 composePromptText 拼出的模型正文同一个顺序；
   * 只发图时不造空 text 块——pi 那边会带一个空串块（各 provider 发送前自己滤掉），
   * 我们这本账不记这种残影。
   */
  userPrompt(
    text: string,
    images: readonly Extract<UserContent, { type: "image" }>[] = [],
    extras: readonly string[] = [],
  ): TranscriptProgress[] {
    const content: UserContent[] = [
      ...(text !== "" || (images.length === 0 && extras.length === 0) ? [{ type: "text" as const, text }] : []),
      ...extras.map((extra): UserContent => ({ type: "text", text: extra })),
      ...images,
    ];
    const item: TranscriptItem = {
      id: this.deps.newId(),
      role: "user",
      content,
      timestamp: this.deps.now(),
    };
    return [{ type: "item_started", item }];
  }

  /** 主转换。返回 0..n 条 progress——调用方按序发出去即可。 */
  apply(event: AdaptableEvent): TranscriptProgress[] {
    if (event.type === "message_start") {
      if (!isAssistant(event.message)) return [];
      const id = this.deps.newId();
      this.activeAssistantId = id;
      this.genStart = this.deps.now();
      return [{ type: "item_started", item: this.streamingAssistantItem(id, event.message) }];
    }

    if (event.type === "message_update") {
      const id = this.activeAssistantId;
      if (id === null || !isAssistant(event.message)) return [];
      const delta = this.toDelta(id, event.assistantMessageEvent);
      // 非增量帧（text_start / text_end / start 等）：整条重发一次，让归约器与上游对齐。
      // 这些帧稀疏，代价可以接受；而漏掉它们会让「块刚出现」这类结构变化丢失。
      return delta ?? [{ type: "item_updated", item: this.streamingAssistantItem(id, event.message) }];
    }

    if (event.type === "message_end") {
      // 终态帧。**abort 也走这里**——pi 的 agent-loop 是先无条件发
      // message_end、之后才判 stopReason === "aborted"，所以被打断的半截回答同样
      // 会经过这里落到 item_finished 上。终态具体是哪一种由 stopReason 决定。
      const id = this.activeAssistantId;
      if (id === null || !isAssistant(event.message)) return [];
      this.activeAssistantId = null;
      // 纯生成时长挂终态帧：message_start 到 message_end 的钟——工具执行在两条消息之间，
      // 天然不计入。跟着回答落盘、重开即回。速度由 renderer 按**整轮**把各条的 usage.output
      // 与 genMs 加总后算（shared/message-speed.ts）——单条算不代表这轮，末条常常只有几百毫秒。
      // 字段不在 pi 的 schema 上，归约器实测原样保留（探针 2026-09-06）。
      const genMs = this.genStart !== null ? this.deps.now() - this.genStart : undefined;
      this.genStart = null;
      return [
        {
          type: "item_finished",
          item: this.finalAssistantItem(id, event.message, genMs),
        },
      ];
    }

    if (event.type === "tool_execution_start") {
      const id = this.deps.newId();
      this.activeTools.set(event.toolCallId, { id, input: event.args });
      return [
        {
          type: "item_started",
          item: this.runningToolItem(id, event.toolCallId, event.toolName, event.args, []),
        },
      ];
    }

    if (event.type === "tool_execution_update") {
      const active = this.activeTools.get(event.toolCallId);
      if (active === undefined) return [];
      return [
        {
          type: "item_updated",
          item: this.runningToolItem(
            active.id,
            event.toolCallId,
            event.toolName,
            active.input,
            toToolContent(event.partialResult),
            toToolDetails(event.partialResult),
          ),
        },
      ];
    }

    // tool_execution_end：终态帧。没有配对的 start 就丢弃——凭空造一条没有入参的
    // 工具记录，比不记更差：重开会话时它看起来像一次真实发生过的、参数为空的调用。
    const active = this.activeTools.get(event.toolCallId);
    if (active === undefined) return [];
    this.activeTools.delete(event.toolCallId);
    return [
      {
        type: "item_finished",
        item: this.finalToolItem(
          active.id,
          event.toolCallId,
          event.toolName,
          active.input,
          toToolContent(event.result),
          event.isError ? "error" : "complete",
          toToolDetails(event.result),
        ),
      },
    ];
  }

  /**
   * 工具执行 → 协议的 tool item。
   *
   * 协议把 `status` 与 `isError` 做成了**绑定的三个变体**（running/false、complete/false、
   * error/true），不能自由组合；且 item_finished 槽位不收 running、item_started / item_updated
   * 不收终态——所以按生命周期拆两个构造函数，返回类型各自与槽位同宽。
   */
  private runningToolItem(
    id: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    content: ToolContent[],
    details?: ToolTranscriptItem["details"],
  ): RunningToolItem {
    return {
      ...this.toolBase(id, toolCallId, toolName, input, content, details),
      status: "running" as const,
      isError: false,
    };
  }

  private finalToolItem(
    id: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    content: ToolContent[],
    status: "complete" | "error",
    details?: ToolTranscriptItem["details"],
  ): FinalToolItem {
    const base = this.toolBase(id, toolCallId, toolName, input, content, details);
    return status === "error"
      ? { ...base, status: "error" as const, isError: true }
      : { ...base, status: "complete" as const, isError: false };
  }

  private toolBase(
    id: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    content: ToolContent[],
    details: ToolTranscriptItem["details"],
  ) {
    return {
      id,
      role: "tool" as const,
      toolCallId,
      toolName,
      // 上游 args 是 any/unknown，协议要 JsonValue——入参本来就是模型产出的 JSON，
      // 这一处断言是唯一的形合点
      input: input as ToolTranscriptItem["input"],
      content,
      timestamp: this.deps.now(),
      ...(details === undefined ? null : { details }),
    };
  }

  /** 流式增量 → assistant_delta。不是增量帧就返回 null，由调用方走整条重发。 */
  private toDelta(messageId: string, event: AssistantStreamEvent): TranscriptProgress[] | null {
    const kind =
      event.type === "text_delta"
        ? "text"
        : event.type === "thinking_delta"
          ? "thinking"
          : event.type === "toolcall_delta"
            ? "toolCall"
            : null;
    if (kind === null) return null;
    const withDelta = event as { contentIndex?: number; delta?: string };
    if (typeof withDelta.contentIndex !== "number" || typeof withDelta.delta !== "string") return null;
    return [
      {
        type: "assistant_delta",
        messageId,
        contentIndex: withDelta.contentIndex,
        kind,
        delta: withDelta.delta,
      },
    ];
  }

  /**
   * 终态怎么落，取决于 pi 的 `stopReason`。
   *
   * **协议里 assistant 有四种 status：streaming / complete / error / aborted**，
   * 后三种都带 `stopReason`，且 error 变体绑死 `stopReason: "error"`（协议的绑定变体，
   * 不能自由组合——此前 error 落的是 "stop"，在 typecheck 盲区里漏了三年才被 0-3 抓出来）。
   * 我们以前一律写 complete 且不带 stopReason——于是**被用户打断的半截回答，
   * 在记录里长得和正常说完的一模一样**。落盘之后这条谎会留在磁盘上：重开会话时
   * 看到一句没说完的话，却没有任何东西告诉你「这是你当时按了停止」。
   */
  private finalAssistantItem(
    id: string,
    message: AssistantMessage,
    genMs?: number,
  ): FinalAssistantItem & WithGenMs {
    const base = {
      id,
      role: "assistant" as const,
      content: message.content.map(toAssistantContent),
      model: toModelRef(message),
      // usage 随帧透传：renderer 的 token 速度靠终态帧上的它记账，丢了就算不出来
      usage: message.usage,
      timestamp: this.deps.now(),
    };
    // genMs 是我们挂在 pi item 上的字段（不在 pi schema 上，归约器实测原样保留）：
    // 本条的纯生成毫秒。**只附加，不劫持**——aborted / error / toolUse 的终态判定
    // 原样走，哪一种终态都能挂。
    const withSpeed = (item: FinalAssistantItem): FinalAssistantItem & WithGenMs =>
      genMs === undefined ? item : { ...item, genMs };
    // aborted 这一支的 stopReason 是它自己那个字面量，不是 complete 那三个之一
    if (message.stopReason === "aborted") {
      return withSpeed({ ...base, status: "aborted" as const, stopReason: "aborted" as const });
    }
    if (message.stopReason === "error") {
      return withSpeed({ ...base, status: "error" as const, stopReason: "error" as const });
    }
    // pi 的 StopReason 比协议宽（还有 pending / deferred）。只有 length / toolUse
    // 两个值协议认；其余落回 "stop"——它表示「就这么结束了」，是最不失真的兜底。
    const stopReason =
      message.stopReason === "length" || message.stopReason === "toolUse"
        ? message.stopReason
        : ("stop" as const);
    return withSpeed({ ...base, status: "complete" as const, stopReason });
  }

  /** 流式中的 assistant 条目：只有 streaming 一个变体，item_started / item_updated 槽都收。 */
  private streamingAssistantItem(id: string, message: AssistantMessage): StreamingAssistantItem {
    return {
      id,
      role: "assistant" as const,
      content: message.content.map(toAssistantContent),
      model: toModelRef(message),
      usage: message.usage,
      timestamp: this.deps.now(),
      status: "streaming" as const,
    };
  }
}
