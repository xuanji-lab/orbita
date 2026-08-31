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
import type { SessionSnapshot, TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentEvent } from "@shared/agent-ipc";
import type { SessionRecord } from "@shared/session";

/** 一次待应答的工具审批。requestId = `${sessionId}:${toolCallId}`，全局唯一。 */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
}

/** 一条会话在 renderer 里的全部运行时状态。 */
export interface SessionEntry {
  transcript: TranscriptState;
  /** turn = 这一轮还在跑；idle = 可以发下一句 */
  phase: "idle" | "turn";
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
  phase: "idle",
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
      phase: event.phase === "idle" ? "idle" : "turn",
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
    return entry === undefined ? states : setEntryPhase(states, event.sessionId, "idle");
  }
  return states;
}

/** 指定槽的 phase。槽不存在就建（send 的乐观 turn 先于任何事件到达时用）。 */
export function setEntryPhase(
  states: SessionStates,
  sessionId: string,
  phase: "idle" | "turn",
): SessionStates {
  return update(states, sessionId, (entry) => ({ ...entry, phase }));
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
  // 压缩界碑不是消息，pi 的归约器不认识它——只把往来种进去；界碑进槽是下一步的事。
  // 内联谓词而非 isCompactedRecord()：本文件会被 node --test 加载，@shared 的值导入解析不了。
  const items = transcript.filter((item): item is TranscriptItem => item.role !== "compacted");
  const next = new Map(states);
  next.set(sessionId, {
    transcript: createTranscriptState(seedSnapshot(items)),
    phase: "idle",
    approvals: [],
  });
  return next;
}

/** 按 requestId 跨槽摘除一条审批。没有匹配就原样返回（同一引用）。 */
export function removeApproval(states: SessionStates, requestId: string): SessionStates {
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

/** runtime 没了：所有还在 turn 的槽一并归位。全是 idle 时返回原引用。 */
export function markAllIdle(states: SessionStates): SessionStates {
  let changed = false;
  const next = new Map<string, SessionEntry>();
  for (const [sessionId, entry] of states) {
    if (entry.phase === "turn") {
      next.set(sessionId, { ...entry, phase: "idle" });
      changed = true;
    } else {
      next.set(sessionId, entry);
    }
  }
  return changed ? next : states;
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
