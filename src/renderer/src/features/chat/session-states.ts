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
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot, TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentEvent, RetryStatus } from "@shared/agent-ipc";
import type { CompactedRecord, SessionRecord } from "@shared/session";

/** 一次待应答的工具审批。requestId = `${sessionId}:${toolCallId}`，全局唯一。 */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
}

/**
 * 本地待办的一条：text = 压缩期间发的普通消息（pi 压缩中连入队入口都关着）；
 * compact = 排队的手动 `/compact`（pi 队列只能存消息文本，压缩指令进不去，
 * 只能本地等时机）。两者都不能进 pi 队列，所以都排在这里。
 */
export type PendingSend = { kind: "text"; text: string } | { kind: "compact"; instructions?: string };

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
  /** turn = 这一轮还在跑；compaction = 上下文压缩中（居中呼吸行）；idle = 可以发下一句 */
  phase: "idle" | "turn" | "compaction";
  /**
   * pi 排队消息的快照（queue 事件全量覆盖）。steering = 已插队等工具边界注入；
   * followUp = 等本轮结束投递。投递 / 清队后 pi 重发整份，UI 的排队卡片随之消失。
   * 纯 ephemeral，不落盘。
   */
  queue: { steering: readonly string[]; followUp: readonly string[] };
  /**
   * 本地待发队列：phase 一离开 compaction，text 项立刻 submit（runtime 侧自动分流：
   * 空闲正常发、又在跑就进 pi 队列）；compact 项必须等 phase 完全 idle 才执行——
   * 排队消息（pi 队列里的）全处理完再压，压的就是完整对话。纯 ephemeral。
   */
  pendingSends: readonly PendingSend[];
  /**
   * 自动重试进行态（等待下一次重试中）。非 null 时：phase 为 turn 则重试行替换
   * Responding，phase 为 compaction 则补在压缩行下。任何 phase 事件都会清空它
   * ——重试尝试开跑时 pi 再发的 agent_start 就是天然的清除信号，不依赖 retry
   * 事件的 null 到达，丢了也自愈。纯 ephemeral，不落盘。
   */
  retry: RetryStatus | null;
  /**
   * 最近一次用量快照。null = 还没有——纯浏览的旧会话不起 runtime session，
   * 不落盘也不算假数，等用户说话唤醒后由 runtime 的第一次推送填上。
   */
  stats: SessionStats | null;
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
  phase: "idle",
  queue: { steering: [], followUp: [] },
  pendingSends: [],
  retry: null,
  stats: null,
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
      // pendingSends 不在这里清：执行与消费由 hook 在事件那拍完成（见 useChatSession），
      // reducer 不知道 hook 执行到哪，抢先清会把没执行的消息丢掉。
      retry: null,
    }));
  }
  if (event.type === "queue") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      queue: { steering: event.steering, followUp: event.followUp },
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
    return entry === undefined ? states : setEntryPhase(states, event.sessionId, "idle");
  }
  return states;
}

/** 指定槽的 phase，顺带清重试槽。槽不存在就建（send 的乐观 turn 先于任何事件到达时用）。 */
export function setEntryPhase(
  states: SessionStates,
  sessionId: string,
  phase: SessionEntry["phase"],
): SessionStates {
  // 乐观 turn（新一轮开始）与 failed 归位都不该留上一次的倒数
  return update(states, sessionId, (entry) => ({ ...entry, phase, retry: null }));
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
): SessionStates {
  // 界碑不进 pi 的归约器（它不是消息），分开记账；实时与历史从此是同一条显示路径。
  // 内联 role 谓词而非 isCompactedRecord()：本文件被 node --test 加载，@shared 的值导入解析不了。
  const items = transcript.filter((item): item is TranscriptItem => item.role !== "compacted");
  const compactions = transcript.filter(
    (item): item is CompactedRecord => item.role === "compacted",
  );
  const next = new Map(states);
  next.set(sessionId, {
    transcript: createTranscriptState(seedSnapshot(items)),
    compactions,
    phase: "idle",
    // 排队是 ephemeral：盘上没有，也不该有（会话断了一次排队就物理消失了）
    queue: { steering: [], followUp: [] },
    pendingSends: [],
    retry: null,
    // 盘上没有用量（真源在 pi 的本子里）：种盘清掉旧值，等唤醒后的第一次推送
    stats: null,
    approvals: [],
  });
  return next;
}

/**
 * 视图合成：界碑按发生位置插回往来流。**历史一条不少地保持可见**——
 * 被收进「已压缩」折叠行的是摘要本身（它才是混进对话的内部消息），
 * 不是压缩点之前的往来。pi 的「边界前隐藏」语义在这里被用户裁决否决：
 * 可追溯是产品底线，pi 的做法照搬错了对象。
 */
export function mergeCompactions(
  compactions: readonly CompactedRecord[],
  transcript: readonly TranscriptItem[],
): SessionRecord[] {
  if (compactions.length === 0) return [...transcript];
  const records: SessionRecord[] = [...transcript, ...compactions];
  // 同毫秒时界碑排在前（两边都是界碑则保持原序）
  records.sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      Number(b.role === "compacted") - Number(a.role === "compacted"),
  );
  return records;
}

/**
 * 界碑折叠行的文案。tokensAfter 是估算值（pi 的 estimate），旧记录没有：
 * 没有 → 只说压之前多大；有 → 「N → M」把压缩效果摆出来。
 */
export function compactionBoundaryText(record: CompactedRecord): string {
  const before = record.tokensBefore.toLocaleString("en-US");
  if (record.tokensAfter === undefined) {
    return `已压缩 · 此前上下文约 ${before} tokens`;
  }
  return `已压缩 · ${before} → ${record.tokensAfter.toLocaleString("en-US")} tokens`;
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
      entry.queue.steering.length > 0 ||
      entry.queue.followUp.length > 0 ||
      entry.pendingSends.length > 0;
    if (busy) {
      next.set(sessionId, {
        ...entry,
        phase: "idle",
        retry: null,
        // runtime 进程没了 = pi 的队列与缓冲物理消失，槽里不留尸体
        queue: { steering: [], followUp: [] },
        pendingSends: [],
      });
      changed = true;
    } else {
      next.set(sessionId, entry);
    }
  }
  return changed ? next : states;
}

/** 本地待办入队（压缩期间的消息、排队的手动压缩）。 */
export function addPendingSend(states: SessionStates, sessionId: string, item: PendingSend): SessionStates {
  return update(states, sessionId, (entry) => ({ ...entry, pendingSends: [...entry.pendingSends, item] }));
}

/** 改写一条本地待办的文本（text 项改 text；compact 项目前不支持编辑）。 */
export function editPendingSend(states: SessionStates, sessionId: string, index: number, text: string): SessionStates {
  const entry = states.get(sessionId);
  const item = entry?.pendingSends[index];
  if (item === undefined || item.kind !== "text") return states;
  return update(states, sessionId, (current) => ({
    ...current,
    pendingSends: current.pendingSends.map((pending, i) => (i === index ? { kind: "text", text } : pending)),
  }));
}

/** 取消一条本地待办。纯本地状态，即点即删，按下标定位；越界原样返回。 */
export function removePendingSend(states: SessionStates, sessionId: string, index: number): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || index < 0 || index >= entry.pendingSends.length) return states;
  return update(states, sessionId, (current) => ({
    ...current,
    pendingSends: current.pendingSends.filter((_, i) => i !== index),
  }));
}

/**
 * 消费前 n 条本地待办（hook 已执行它们）。越界的 n 当清空处理——执行方与消费方
 * 读的是同一份快照，越界只在竞态下发生，宁可少留不可重发。
 */
export function consumePendingSends(states: SessionStates, sessionId: string, count: number): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || count <= 0) return states;
  const nextItems = entry.pendingSends.slice(count);
  if (nextItems.length === entry.pendingSends.length) return states;
  return update(states, sessionId, (current) => ({ ...current, pendingSends: nextItems }));
}

/** 消费全部 text 项（agent 又跑起来的那拍：文本安全进 pi 队列，compact 继续等 idle）。 */
export function consumePendingTexts(states: SessionStates, sessionId: string): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || !entry.pendingSends.some((item) => item.kind === "text")) return states;
  return update(states, sessionId, (current) => ({
    ...current,
    pendingSends: current.pendingSends.filter((item) => item.kind !== "text"),
  }));
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
    thinkingLevel: "off",
    attached: true,
    locked: false,
    revision: 0,
    transcript: [...transcript],
    queuedSteer: [],
    queuedSteerCount: 0,
  };
}
