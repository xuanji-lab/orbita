/**
 * 每会话状态槽 —— 「切走就丢事件」的根因修复（docs/plans/2026-08-31-会话切换实时刷新.md）。
 *
 * 老实现是**单份** TranscriptState + 按 `sessionRef` 过滤事件：切走正在跑的会话，
 * 它的事件被直接扔掉，切回来只能读到落盘的部分然后卡住。这里改成
 * **一个会话一个槽**（transcript / phase / 审批），事件无条件进自己的槽——
 * 「看哪条」只是显示问题，不再决定「记不记」。
 *
 * 本文件是纯函数（不碰 React、不碰 IPC），事件的归约可以脱离 hook 单测。
 * transcript 归约沿用 **pi 自带的归约器**，我们不写第二份（guideline §三）。
 */
import {
  applyTranscriptProgress,
  createTranscriptState,
  type TranscriptState,
} from "@earendil-works/pi-coding-agent/client";
import type { SessionSnapshot, ThinkingLevel as PiThinkingLevel, TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentEvent, AgentStats, RetryStatus } from "@shared/agent-ipc";
import type { ChannelMessage } from "@shared/channel";
import type { PromptImage } from "@shared/prompt-images";
import type { ComposerFileRef, ComposerPastedText } from "../../shell/composer-attachments.ts";
import type { ChannelMarkRecord, CompactedRecord, SessionRecord } from "@shared/session";
import type { Messages } from "../../messages-en.ts";

/** 一次待应答的工具审批。requestId = `${sessionId}:${toolCallId}`，全局唯一。 */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
}

/**
 * 排队里的一条。
 *
 * **队列归我们，pi 不持有排队状态**（见
 * `docs/plans/2026-09-06-排队队列所有权收回.md`）。
 * `id` 是稳定身份：所有操作（撤回 / 拖拽 / 立即发送）按 id 定位，
 * 不再用下标加文本对账——那套对账在连续操作时必然落空（2026-09-06 事故）。
 *
 * `kind`：text = 一条普通消息；compact = 排队的手动 `/compact`（它是命令不是消息，
 * 执行时机另受约束：必须等完全空闲）；channel = 子会话通道投给这条会话的一条消息
 * （子会话 PR4a：子→父恒 followUp，进父的 renderer 队列，排队所有权与 text 同一套）。
 * channel 条目的 `id` 用 `message.id`——通道账本铸的 id，天然全局唯一，也用它去重
 * （同一条 `channel:event` 因订阅重连等原因重复到达时，队列里已有同 id 就不再入队）。
 */
export type QueuedMessage =
  /** images：随这条排队的附图（缺席 = 纯文字）。排队时就读成 base64，投递时原样交出去。
   * files / pasted：同行的文件引用与粘贴文本块（语义见 shared/prompt-attachments.ts），
   * 投递时原样交出去；撤回时原样回输入框 */
  | {
      id: string;
      kind: "text";
      text: string;
      images?: readonly PromptImage[];
      files?: readonly ComposerFileRef[];
      pasted?: readonly ComposerPastedText[];
    }
  | { id: string; kind: "compact"; instructions?: string }
  | { id: string; kind: "channel"; childId: string; message: ChannelMessage };

/**
 * 输入框里的手动压缩指令：`/compact` 直接压缩，`/compact <要求>` 带自定义要求。
 * **必须在这里拦下**——发出去的话它会落到模型手里，模型会角色扮演一段
 * 「摘要」贴进对话，而什么都没压缩（真实发生过的事故，刀 0-3 的验收发现）。
 * null = 不是压缩指令，照常发送。
 */
export function parseCompactCommand(text: string): { instructions?: string } | null {
  const trimmed = text.trim();
  if (trimmed === "/compact") return {};
  if (trimmed.startsWith("/compact ")) {
    return { instructions: trimmed.slice("/compact ".length).trim() || undefined };
  }
  return null;
}

/** 一条会话在 renderer 里的全部运行时状态。 */
export interface SessionEntry {
  transcript: TranscriptState;
  /**
   * 压缩界碑单独记账，**不进 pi 的归约器**——它不是消息，归约器不认识。
   * 显示时由 `applyCompactionBoundary` 按时间插回往来流。
   */
  compactions: CompactedRecord[];
  /**
   * 通道标记单独记账（子会话 PR4a），与 compactions 同一条纪律：**不进 pi 的归约器**——
   * 它顶替的是一条 user 消息，但正文只有一份、在通道账本里，归约器不认识它。
   * 显示时由 `mergeSideRecords` 按时间插回往来流。
   */
  marks: readonly ChannelMarkRecord[];
  /** turn = 这一轮还在跑；compaction = 上下文压缩中（居中呼吸行）；idle = 可以发下一句 */
  phase: "idle" | "turn" | "compaction";
  /**
   * 排队队列——**唯一真源**，按显示顺序存。
   *
   * 不再有 pi 快照、不再有顺序账本、不再有另一套本地待办：那三份要互相对账，
   * 而对账只能靠文本（pi 队列里只有裸字符串），一旦某次落空就永久分叉。
   * 现在只有这一份，按 id 操作，拖拽就是一次 splice。
   *
   * 投递时机也归我们：`phase` 回到 idle 时取第一条发，而不是由 pi 的 post-run
   * 自动 drain（那会把好几条一起吹出去）。纯 ephemeral，不落盘。
   */
  queued: readonly QueuedMessage[];
  /**
   * 自动重试进行态（等待下一次重试中）。非 null 时：phase 为 turn 则重试行替换
   * Responding，phase 为 compaction 则补在压缩行下。任何 phase 事件都会清空它
   * ——重试尝试开跑时 pi 再发的 agent_start 就是天然的清除信号，不依赖 retry
   * 事件的 null 到达，丢了也自愈。纯 ephemeral，不落盘。
   */
  retry: RetryStatus | null;
  /**
   * 回合级失败标注（重试耗尽）：渲染在转录末尾——正是这轮没送出去的那条用户消息
   * 下面。**新一轮开跑即清**（非 idle 的 phase 事件 / 乐观置 turn），落定的 idle
   * 不清（failed 之后紧随的 agent_settled 不能把标注抹掉）。纯 ephemeral，不落盘。
   */
  turnError: string | null;
  /**
   * 最近一次用量快照。null = 还没有——纯浏览的旧会话不起 runtime session，
   * 不落盘也不算假数，等用户说话唤醒后由 runtime 的第一次推送填上。
   */
  stats: AgentStats | null;
  /**
   * 思考档真值（clamp 后的事实 + 模型支持集）。null = 还没开过轮——芯片显示
   * meta 里的意图档，下一轮并跑时 runtime 的第一次推送会填上真值。ephemeral，不落盘。
   */
  thinking: { level: PiThinkingLevel; supported: readonly PiThinkingLevel[] } | null;
  approvals: PendingApproval[];
}

/** 全部会话的槽。**不可变**：每个事件产出新 Map，没变的槽保持同一引用。 */
export type SessionStates = ReadonlyMap<string, SessionEntry>;

export function createSessionStates(): SessionStates {
  return new Map<string, SessionEntry>();
}

/** 空槽是常量：首页/无选中时用它兜底，避免每次渲染新建 TranscriptState。 */
export const EMPTY_ENTRY: SessionEntry = {
  transcript: createTranscriptState(seedSnapshot()),
  compactions: [],
  marks: [],
  phase: "idle",
  queued: [],
  retry: null,
  turnError: null,
  stats: null,
  thinking: null,
  approvals: [],
};

/**
 * 事件的唯一入口。progress / phase / permission / failed 各进各的槽；
 * ready / builtins / created 与槽无关（live 集合是 hook 自己的账）。
 * 没有对应槽时**就地建槽**——renderer 重载后事件照样开始累积。
 */
export function applyAgentEvent(states: SessionStates, event: AgentEvent): SessionStates {
  if (event.type === "progress") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      transcript: applyTranscriptProgress(entry.transcript, event.progress),
    }));
  }
  if (event.type === "phase") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      phase: event.phase === "idle" ? "idle" : event.phase === "compaction" ? "compaction" : "turn",
      // 任何 phase 事件都清重试槽：重试尝试开跑（agent_start）、整轮落定（settled）、
      // 压缩起止——都是「重试等待结束了」的时刻，倒数行不该再挂。
      // queued 不在这里清：投递由 hook 在 phase 事件那拍驱动（见 useChatSession），
      // reducer 不知道 hook 执行到哪，抢先清会把没发出去的消息丢掉。
      retry: null,
      // 回合失败标注只随「新一轮开跑」消失：非 idle 的 phase 事件清它；
      // 落定的 idle **不清**——failed(turn) 之后紧随的 agent_settled 正是 idle
      ...(event.phase === "idle" ? null : { turnError: null }),
      // 轮结束就不可能还有挂起的审批：停止 / 抢跑时 runtime 已按拒绝把它们结清
      // （审批不听 abort，只能手动结）。卡片留着的话，用户会去回答一个已经不存在的请求。
      ...(event.phase === "idle" ? { approvals: [] } : null),
    }));
  }
  if (event.type === "retry") {
    return update(states, event.sessionId, (entry) => ({ ...entry, retry: event.status }));
  }
  if (event.type === "compaction") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      compactions: [...entry.compactions, event.record],
    }));
  }
  if (event.type === "stats") {
    return update(states, event.sessionId, (entry) => ({ ...entry, stats: event.stats }));
  }
  if (event.type === "thinking") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      thinking: { level: event.level, supported: event.supported },
    }));
  }
  if (event.type === "permission") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      approvals: [
        ...entry.approvals,
        { requestId: event.requestId, toolName: event.toolName, input: event.input },
      ],
    }));
  }
  if (event.type === "failed") {
    // runtime 整个没了：所有槽归位；单条失败只归位那条（不存在的槽不凭空造）
    if (event.sessionId === null) return markAllIdle(states);
    const entry = states.get(event.sessionId);
    if (entry === undefined) return states;
    // 回合级失败（重试耗尽）：标注进槽，渲染在这轮没送出去的消息下面；
    // 操作级失败照旧只归位——它的红字在 hook 的全局 error 上
    if (event.turn === true) {
      return update(states, event.sessionId, (current) => ({
        ...current,
        phase: "idle",
        retry: null,
        turnError: event.message,
      }));
    }
    return setEntryPhase(states, event.sessionId, "idle");
  }
  return states;
}

/** 指定槽的 phase，顺带清重试槽。槽不存在就建（send 的乐观 turn 先于任何事件到达时用）。 */
export function setEntryPhase(
  states: SessionStates,
  sessionId: string,
  phase: SessionEntry["phase"],
): SessionStates {
  // 乐观 turn（新一轮开始）与 failed 归位都不该留上一次的倒数；
  // 新一轮开跑（非 idle）也清回合失败标注——用户已经在重试那句话了
  return update(states, sessionId, (entry) => ({
    ...entry,
    phase,
    retry: null,
    ...(phase === "idle" ? null : { turnError: null }),
  }));
}

/**
 * 用落盘的 transcript 覆盖一个槽。**整槽覆盖**：历史会话的真相在盘上，
 * 顺带把上次看它时留下的审批清掉——与老实现 `setApprovals([])` 同语义。
 * 活会话**不走这里**：槽里的累积比盘新，种盘等于回退。
 */
export function seedFromDisk(
  states: SessionStates,
  sessionId: string,
  transcript: readonly SessionRecord[],
  stats: AgentStats | null = null,
): SessionStates {
  // 界碑与通道标记都不进 pi 的归约器（它们不是模型消息，归约器不认识）——分开记账，
  // 显示时由 mergeSideRecords 按时间插回往来流；实时与历史从此是同一条显示路径。
  // 内联 role 谓词而非 isCompactedRecord()/isChannelMarkRecord()：本文件被 node --test
  // 加载，@shared 的值导入解析不了（AGENTS.md 硬规则）。
  const items = transcript.filter(
    (item): item is TranscriptItem => item.role !== "compacted" && item.role !== "channel-mark",
  );
  const compactions = transcript.filter(
    (item): item is CompactedRecord => item.role === "compacted",
  );
  const marks = transcript.filter(
    (item): item is ChannelMarkRecord => item.role === "channel-mark",
  );
  const next = new Map(states);
  next.set(sessionId, {
    transcript: createTranscriptState(seedSnapshot(items)),
    compactions,
    marks,
    phase: "idle",
    // 排队是 ephemeral：盘上没有，也不该有（会话断了一次排队就物理消失了）
    queued: [],
    retry: null,
    // 盘上没有失败标注（纯 ephemeral）：种盘即清
    turnError: null,
    // **盘上有用量**（A1-Q1：`SessionMeta.stats` 存的是上一次跑完时的快照）。
    // 种盘就把它放回来——否则关掉应用再打开，底栏是空的，而账本明明还在。
    // 唤醒后 agent 会推真累计覆盖它（pi 的本子才是原始账本，这里只是上次看到的样子）。
    stats,
    // 思考档真值不落盘（meta 里的意图档才是持久事实）：种盘即空，等下一次开轮的推送
    thinking: null,
    approvals: [],
  });
  return next;
}

/**
 * 视图合成：界碑与通道标记都按发生位置插回往来流。**历史一条不少地保持可见**——
 * 被收进「已压缩」折叠行的是摘要本身（它才是混进对话的内部消息），
 * 不是压缩点之前的往来。pi 的「边界前隐藏」语义在这里被用户裁决否决：
 * 可追溯是产品底线，pi 的做法照搬错了对象。
 *
 * 原名 `mergeCompactions`（子会话 PR4a 推广）：通道标记与界碑同一处境——都不进
 * pi 的归约器，都要按 timestamp 插回 transcript——没必要另开一份并行逻辑。
 */
export function mergeSideRecords(
  compactions: readonly CompactedRecord[],
  marks: readonly ChannelMarkRecord[],
  transcript: readonly TranscriptItem[],
): SessionRecord[] {
  if (compactions.length === 0 && marks.length === 0) return [...transcript];
  const records: SessionRecord[] = [...transcript, ...compactions, ...marks];
  // 同毫秒时非 transcript 的一侧记录（界碑 / 通道标记）排在前——界碑在前的老规则
  // 原样保留，通道标记同一条纪律：两者都不是 pi 归约器认识的消息，混排靠落盘
  // 时间戳定序，非 transcript 的一侧优先出现在同刻的前面。
  const isSideRecord = (record: SessionRecord): boolean =>
    record.role === "compacted" || record.role === "channel-mark";
  records.sort(
    (a, b) => a.timestamp - b.timestamp || Number(isSideRecord(b)) - Number(isSideRecord(a)),
  );
  return records;
}

/**
 * 界碑折叠行 status 槽的文案。tokensAfter 是估算值（pi 的 estimate），旧记录没有：
 * 没有 → 只说压之前多大；有 → 「N → M」把压缩效果摆出来。
 * label 是静态词（`Compacted`），归 ChatView 的文案区。数字用千分位精确值、
 * 不走底栏的紧凑写法（formatTokens）——界碑是把压缩效果摆出来给人看一次的，不是常显。
 */
export function compactionBoundaryStatus(record: CompactedRecord, t: Messages): string {
  const before = record.tokensBefore.toLocaleString("en-US");
  if (record.tokensAfter === undefined) {
    return t.chat.tokensApprox(before);
  }
  return t.chat.tokensArrow(before, record.tokensAfter.toLocaleString("en-US"));
}

/** 按 requestId 跨槽摘除一条审批。没有匹配就原样返回（同一引用）。 */export function removeApproval(states: SessionStates, requestId: string): SessionStates {
  for (const [sessionId, entry] of states) {
    if (!entry.approvals.some((approval) => approval.requestId === requestId)) continue;
    const next = new Map(states);
    next.set(sessionId, {
      ...entry,
      approvals: entry.approvals.filter((approval) => approval.requestId !== requestId),
    });
    return next;
  }
  return states;
}

/** runtime 没了：所有还在忙的槽（turn / 压缩中 / 重试等待中）一并归位。全是 idle 时返回原引用。 */
export function markAllIdle(states: SessionStates): SessionStates {
  let changed = false;
  const next = new Map<string, SessionEntry>();
  for (const [sessionId, entry] of states) {
    const busy =
      entry.phase !== "idle" ||
      entry.retry !== null ||
      entry.queued.length > 0;
    if (busy) {
      next.set(sessionId, {
        ...entry,
        phase: "idle",
        retry: null,
        // runtime 进程没了 = 这一轮彻底断了，排队的消息没人会发，槽里不留尸体
        queued: [],
      });
      changed = true;
    } else {
      next.set(sessionId, entry);
    }
  }
  return changed ? next : states;
}

/** 排队入队：新条目落到队尾，带一个稳定 id。 */
export function enqueue(
  states: SessionStates,
  sessionId: string,
  item: QueuedMessage,
): SessionStates {
  return update(states, sessionId, (entry) => ({ ...entry, queued: [...entry.queued, item] }));
}

/**
 * 子会话通道消息入队（子会话 PR4a）：同 `enqueue`，但先按 id 去重。
 *
 * 子→父投递靠 `channel:event` 广播，订阅重连 / 事件重放等场景可能让同一条
 * `message.id` 到达不止一次——`enqueue` 本身不认识「重复」，重复入队会让同一句
 * 子会话的话在队列 / QueueStrip 里出现两条。队首已有同 id 就原样返回（同一引用，
 * 调用方据此判断没有变化）。
 */
export function enqueueChannelMessage(
  states: SessionStates,
  parentId: string,
  item: Extract<QueuedMessage, { kind: "channel" }>,
): SessionStates {
  const entry = states.get(parentId);
  if (entry !== undefined && entry.queued.some((queued) => queued.id === item.id)) return states;
  return enqueue(states, parentId, item);
}

/** 按 id 移出一条（撤回 / 删除 / 投递后出队都走它）。找不到就原样返回。 */
export function dequeue(states: SessionStates, sessionId: string, id: string): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || !entry.queued.some((item) => item.id === id)) return states;
  return update(states, sessionId, (current) => ({
    ...current,
    queued: current.queued.filter((item) => item.id !== id),
  }));
}

/**
 * 按 id 挪位：把 sourceId 放到 targetId 的前面或后面。
 *
 * 全程按 id，不碰下标——下标会随投递前移，那正是旧实现每次连续操作都落空的原因。
 */
export function moveQueued(
  states: SessionStates,
  sessionId: string,
  sourceId: string,
  targetId: string,
  placement: "before" | "after",
): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || sourceId === targetId) return states;
  const from = entry.queued.findIndex((item) => item.id === sourceId);
  const target = entry.queued.find((item) => item.id === targetId);
  if (from === -1 || target === undefined) return states;
  const rest = entry.queued.filter((item) => item.id !== sourceId);
  const at = rest.findIndex((item) => item.id === targetId);
  if (at === -1) return states;
  const moved = entry.queued[from];
  if (moved === undefined) return states;
  const insertAt = placement === "before" ? at : at + 1;
  const next = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  const unchanged = next.every((item, i) => item.id === entry.queued[i]?.id);
  return unchanged
    ? states
    : update(states, sessionId, (current) => ({ ...current, queued: next }));
}

/**
 * 下一条该投递的是谁。取不到返回 null，调用方什么都不做。
 *
 * 条件只有一个：**完全空闲**。队列归我们之后，投递就发生在「上一轮落定」那一拍，
 * 没必要再区分消息与 `/compact`——两者都只在 idle 时发。
 * 这也是「一次只跑一轮」的保障：轮还在跑就不放下一条，
 * 不会出现 pi 的 post-run 那种「好几条一起吹出去」。
 */
export function nextDeliverable(entry: SessionEntry): QueuedMessage | null {
  if (entry.phase !== "idle") return null;
  return entry.queued[0] ?? null;
}


/** 会话被删除：槽一并丢掉，否则它连同整份 transcript 在 renderer 内存里留一具尸体。 */
export function removeSessionEntry(states: SessionStates, sessionId: string): SessionStates {
  if (!states.has(sessionId)) return states;
  const next = new Map(states);
  next.delete(sessionId);
  return next;
}

function update(
  states: SessionStates,
  sessionId: string,
  patch: (entry: SessionEntry) => SessionEntry,
): SessionStates {
  const entry = states.get(sessionId) ?? EMPTY_ENTRY;
  const next = new Map(states);
  next.set(sessionId, patch(entry));
  return next;
}

/**
 * 归约器的起点快照。打开旧会话时**把落盘的 transcript 种进去**，
 * 之后的 progress 直接往下追加——实时与历史是同一条渲染路径。
 */
function seedSnapshot(transcript: readonly TranscriptItem[] = []): SessionSnapshot {
  const now = Date.now();
  return {
    id: "local",
    cwd: ".",
    createdAt: now,
    updatedAt: now,
    phase: "idle",
    model: { provider: "pending", id: "pending" },
    thinkingLevel: "medium",
    attached: true,
    locked: false,
    revision: 0,
    transcript: [...transcript],
    queuedSteer: [],
    queuedSteerCount: 0,
  };
}
