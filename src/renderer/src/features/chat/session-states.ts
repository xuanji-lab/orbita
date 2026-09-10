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
import type { AgentEvent, AgentStats, RetryStatus } from "@shared/agent-ipc";
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
   * 排队项的进入顺序账本（键序 = 输入序）。pi 队列项与本地待办存在两个队列里，
   * 快照各自有序、合起来无序——卡片要按输入序显示，就得记这份账。键与快照对账
   * （见 syncQueueOrder）：消失的键删掉，新键补到尾部。纯 ephemeral。
   */
  queueOrder: readonly string[];
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
  queueOrder: [],
  pendingSends: [],
  retry: null,
  turnError: null,
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
      // 回合失败标注只随「新一轮开跑」消失：非 idle 的 phase 事件清它；
      // 落定的 idle **不清**——failed(turn) 之后紧随的 agent_settled 正是 idle
      ...(event.phase === "idle" ? null : { turnError: null }),
    }));
  }
  if (event.type === "queue") {
    return update(states, event.sessionId, (entry) =>
      syncQueueOrder({
        ...entry,
        queue: { steering: event.steering, followUp: event.followUp },
      }),
    );
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
    queueOrder: [],
    pendingSends: [],
    retry: null,
    // 盘上没有失败标注（纯 ephemeral）：种盘即清
    turnError: null,
    // **盘上有用量**（A1-Q1：`SessionMeta.stats` 存的是上一次跑完时的快照）。
    // 种盘就把它放回来——否则关掉应用再打开，底栏是空的，而账本明明还在。
    // 唤醒后 agent 会推真累计覆盖它（pi 的本子才是原始账本，这里只是上次看到的样子）。
    stats,
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
 * 界碑折叠行 status 槽的文案。tokensAfter 是估算值（pi 的 estimate），旧记录没有：
 * 没有 → 只说压之前多大；有 → 「N → M」把压缩效果摆出来。
 * label 是静态词（`Compacted`），归 ChatView 的文案区。数字用千分位精确值、
 * 不走底栏的紧凑写法（formatTokens）——界碑是把压缩效果摆出来给人看一次的，不是常显。
 */
export function compactionBoundaryStatus(record: CompactedRecord): string {
  const before = record.tokensBefore.toLocaleString("en-US");
  if (record.tokensAfter === undefined) {
    return `~${before} tokens`;
  }
  return `${before} → ${record.tokensAfter.toLocaleString("en-US")} tokens`;
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
        // runtime 进程没了 = pi 的队列与待办物理消失，槽里不留尸体
        queue: { steering: [], followUp: [] },
        queueOrder: [],
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
  return update(states, sessionId, (entry) =>
    syncQueueOrder({ ...entry, pendingSends: [...entry.pendingSends, item] }),
  );
}

/** 取消一条本地待办。纯本地状态，即点即删，按下标定位；越界原样返回。 */
export function removePendingSend(states: SessionStates, sessionId: string, index: number): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || index < 0 || index >= entry.pendingSends.length) return states;
  return update(states, sessionId, (current) =>
    syncQueueOrder({
      ...current,
      pendingSends: current.pendingSends.filter((_, i) => i !== index),
    }),
  );
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
  return update(states, sessionId, (current) =>
    syncQueueOrder({ ...current, pendingSends: nextItems }),
  );
}

/** 消费全部 text 项（agent 又跑起来的那拍：文本安全进 pi 队列，compact 继续等 idle）。 */
export function consumePendingTexts(states: SessionStates, sessionId: string): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || !entry.pendingSends.some((item) => item.kind === "text")) return states;
  return update(states, sessionId, (current) =>
    syncQueueOrder({
      ...current,
      pendingSends: current.pendingSends.filter((item) => item.kind !== "text"),
    }),
  );
}

/**
 * 乐观移除 pi 队列的第 index 条（`[...steering, ...followUp]` 拼接视图下标）：
 * 取消 / 收回的**即时**反馈，不等 runtime 的 queue 事件绕一圈 IPC 回来。
 * 之后到达的 queue 事件本就全量覆盖本槽——操作落空时条目随事件原样回来
 * （自愈），不需要回滚逻辑。
 */
export function removeQueued(states: SessionStates, sessionId: string, index: number): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined) return states;
  const steering = [...entry.queue.steering];
  const followUp = [...entry.queue.followUp];
  if (index >= 0 && index < steering.length) {
    steering.splice(index, 1);
  } else if (index >= steering.length && index - steering.length < followUp.length) {
    followUp.splice(index - steering.length, 1);
  } else {
    return states;
  }
  return update(states, sessionId, (current) =>
    syncQueueOrder({ ...current, queue: { steering, followUp } }),
  );
}

// ---------------------------------------------------------------------------
// 排队显示合成：pi 队列与本地待办按输入序交错（键 = 来源 + 内容）
// ---------------------------------------------------------------------------

function localQueueKey(item: PendingSend): string {
  return item.kind === "text" ? `local-text\0${item.text}` : `local-compact\0${item.instructions ?? ""}`;
}

/**
 * 账本与两个队列快照对账：消失的键（投递 / 取消 / 执行掉）删除，新出现的键
 * （pi 先按快照序、本地按数组序）补到尾部。没有变化时返回原 entry（保引用）。
 */
function syncQueueOrder(entry: SessionEntry): SessionEntry {
  const piKeys = [...entry.queue.steering, ...entry.queue.followUp].map((text) => `pi\0${text}`);
  const localKeys = entry.pendingSends.map(localQueueKey);
  const alive = new Map<string, number>();
  for (const key of [...piKeys, ...localKeys]) {
    alive.set(key, (alive.get(key) ?? 0) + 1);
  }
  const kept: string[] = [];
  for (const key of entry.queueOrder) {
    const left = alive.get(key) ?? 0;
    if (left > 0) {
      kept.push(key);
      alive.set(key, left - 1);
    }
  }
  const appended: string[] = [];
  for (const key of [...piKeys, ...localKeys]) {
    const left = alive.get(key) ?? 0;
    if (left > 0) {
      appended.push(key);
      alive.set(key, left - 1);
    }
  }
  const next = [...kept, ...appended];
  const unchanged =
    next.length === entry.queueOrder.length && next.every((key, i) => key === entry.queueOrder[i]);
  return unchanged ? entry : { ...entry, queueOrder: next };
}

/** 卡片渲染用的合成视图项：pi 项带拼接视图下标（runtime 命令用），本地项带数组下标。 */
export type QueueViewEntry =
  | { source: "pi"; steering: boolean; text: string; piIndex: number }
  | { source: "local"; item: PendingSend; localIndex: number };

/**
 * pi 队列 + 本地待办 → 按输入序（queueOrder）交错的显示视图。
 * 账本没覆盖到的项（对账竞态漏网）按「pi 先、本地后」补在尾部，保证一条不丢。
 */
export function mergeQueueView(entry: SessionEntry): QueueViewEntry[] {
  const piItems = [
    ...entry.queue.steering.map((text) => ({ steering: true, text })),
    ...entry.queue.followUp.map((text) => ({ steering: false, text })),
  ];
  const piUsed = new Set<number>();
  const localUsed = new Set<number>();
  const view: QueueViewEntry[] = [];
  for (const key of entry.queueOrder) {
    const piIndex = piItems.findIndex(
      (item, i) => !piUsed.has(i) && `pi\0${item.text}` === key,
    );
    if (piIndex !== -1) {
      const hit = piItems[piIndex];
      if (hit !== undefined) {
        piUsed.add(piIndex);
        view.push({ source: "pi", steering: hit.steering, text: hit.text, piIndex });
        continue;
      }
    }
    const localIndex = entry.pendingSends.findIndex(
      (item, i) => !localUsed.has(i) && localQueueKey(item) === key,
    );
    if (localIndex !== -1) {
      const hit = entry.pendingSends[localIndex];
      if (hit !== undefined) {
        localUsed.add(localIndex);
        view.push({ source: "local", item: hit, localIndex });
      }
    }
  }
  for (const [i, item] of piItems.entries()) {
    if (!piUsed.has(i)) view.push({ source: "pi", steering: item.steering, text: item.text, piIndex: i });
  }
  for (const [i, item] of entry.pendingSends.entries()) {
    if (!localUsed.has(i)) view.push({ source: "local", item, localIndex: i });
  }
  return view;
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
