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
import type { ComposerFileRef } from "../../shell/composer-attachments.ts";
import type {
  ChannelMarkRecord,
  CompactedRecord,
  IntentRecallRecord,
  SessionRecord,
} from "@shared/session";
import {
  applyRecallEvent,
  initialRecallCard,
  type RecallCardState,
} from "../../../../shared/intent-recall.ts";
import type { FileTurnView, RevertRecord, UndoRecord } from "@shared/revert";
import type { QuotaExhaustedHint } from "@shared/quota";
import type { TranscriptRecord } from "@shared/session";
import type { Messages } from "../../messages-en.ts";

/**
 * 一次回合级失败的事实：厂商原文 + （可选）主进程按额度缓存补的「窗口用尽」。
 * 两段分开存，句子归 renderer 组（中文界面不能从主进程冒出来）。
 */
export interface TurnFailure {
  message: string;
  /**
   * 失败发生时这个账户有窗口满着（主进程判定，不是按文案猜）。
   * **是账户状态，不是失败原因**：与「钥匙过期」可以同时成立，所以它只作副行。
   */
  quota?: QuotaExhaustedHint;
}

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
   * files：同行的文件引用，投递时原样交出去；撤回时回输入框。粘贴块已内联进 text
   * （token 换 <pasted-text> 块，方案 C），撤回时 draftFromSentText 拆回句中胶囊 */
  | {
      id: string;
      kind: "text";
      text: string;
      images?: readonly PromptImage[];
      files?: readonly ComposerFileRef[];
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
   * 源侧分页的窗口状态。**盘上仍是全量**（JSONL、折叠、续聊语义一字未改），
   * 槽里只装尾部一段：分页分的是 IPC 传输量与渲染量。
   */
  window: {
    /** 已加载窗口的第一条记录 id——`loadOlder` 的 before 锚点，也是滚动锚定的判据 */
    firstId: string | null;
    /** 更早还有记录（触顶要拉的那一页在不在） */
    hasMore: boolean;
    /** 更早的一页在途：顶部指示 + 防重（快速连续触顶只发一次） */
    loading: boolean;
    /**
     * 窗口之前还有几条压缩界碑（主进程数的，见 `SessionWindow.compactionsBefore`）。
     * 拉进更早一页时，那页里的界碑从这里挪进 `compactions`——两者之和恒为会话的压缩次数。
     */
    compactionsBefore: number;
  };
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
   * 收到过几次 phase 事件（只增）。乐观置 turn 的失败归位靠它判「提交以来 runtime
   * 有没有报过真相」——见 revertOptimisticTurn。纯 ephemeral，不落盘。
   */
  phaseEpoch: number;
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
   * 回合级失败标注（重试耗尽 / 不可重试的模型错误）：渲染在转录末尾——正是这轮
   * 没送出去的那条用户消息下面。`message` 是厂商原文（排障信息，不丢）；`quota` 是
   * 主进程按额度缓存补的事实（窗口用尽 + 重置时刻），有它时界面多一句人话。
   * **新一轮开跑即清**（非 idle 的 phase 事件 / 乐观置 turn），落定的 idle
   * 不清（failed 之后紧随的 agent_settled 不能把标注抹掉）。纯 ephemeral，不落盘。
   */
  turnError: TurnFailure | null;
  /**
   * 最近一次用量快照。null = 还没有——纯浏览的旧会话不起 runtime session，
   * 不落盘也不算假数，等用户说话唤醒后由 runtime 的第一次推送填上。
   */
  stats: AgentStats | null;
  /**
   * 思考档真值（clamp 后的事实 + 模型支持集）。null = 还没开过轮——芯片显示
   * meta 里的意图档，下一轮并跑时 runtime 的第一次推送会填上真值。ephemeral，不落盘。
   * providerId / modelId 是报这组真值的型号：切型号后它就过期了，**读一律走
   * observedThinkingFor**，不直接拿 supported（切型号不清这里，按型号判过期）。
   */
  thinking: ObservedThinking | null;
  approvals: PendingApproval[];
  /**
   * 轮尾文件账（revert.ts，与 marks 同一条纪律）：不进归约器，卡片层直接消费；
   * 实时事件（fileTurnView，剥掉正文的视图）与盘上种子（FileTurnRecord，视图的
   * 超集）都归这个桶。
   */
  fileTurns: readonly FileTurnView[];
  /** 回退界碑（盘上种子；回退后全量重读会话，没有实时事件） */
  reverts: readonly RevertRecord[];
  /** 撤销记录（同上，盘上种子）：不渲染单元，轮尾卡据此挂「已撤销」徽标 */
  undos: readonly UndoRecord[];
  /* ---------- 意图系统（实验功能 intent-system）：三个槽 ---------- */
  /** 运行中的召回卡（intentRecall 流事件归约而来；终态记录到达后清空）。ephemeral */
  intentRun: RecallCardState | null;
  /** 终态召回卡：intentRecallRecord 实时事件 + 盘上种子 */
  intentRecalls: readonly IntentRecallRecord[];
  /** 挂起的回答前确认（intentAsk 事件；应答 / 取消后清空）。ephemeral */
  intentAsk: Extract<AgentEvent, { type: "intentAsk" }> | null;
  /**
   * 乐观回显（发出即画的用户气泡）：agent 进程冷启 / 开轮装配要几秒，真回显
   * （runtime 的 progress item_started）之前聊天面会有一段只有「回应中」的空窗。
   * 这里存**与 runtime 同款切法**的正文块（splitEchoBlocks），真回显一到即清。
   * ephemeral。
   */
  pendingEcho: { blocks: readonly string[] } | null;
}

/** 一份运行时报回的思考档真值，连同报它的型号 */
export interface ObservedThinking {
  providerId: string;
  modelId: string;
  level: PiThinkingLevel;
  supported: readonly PiThinkingLevel[];
}

/**
 * 当前型号可用的「运行时报回的支持集」：真值是别的型号报的（会话里切过型号、
 * 还没用新型号开过轮）就当没有，返回 null 让调用方回落白名单 / 目录。
 * 服务商也要对上——同一个型号 id 在两家的支持集可以不同（Kimi Coding 的 k3 三档、
 * OpenCode Go 的 kimi-k3 只开 max）。
 */
export function observedThinkingFor(
  observed: ObservedThinking | null,
  model: { providerId: string; modelId: string } | null,
): readonly PiThinkingLevel[] | null {
  if (observed === null || !sameModel(observed, model)) return null;
  return observed.supported;
}

/** 两个型号引用是不是同一个（服务商 + 型号 id 都要对上）；任一侧为 null 不算 */
export function sameModel(
  a: { providerId: string; modelId: string } | null,
  b: { providerId: string; modelId: string } | null,
): boolean {
  return a !== null && b !== null && a.providerId === b.providerId && a.modelId === b.modelId;
}

/** 全部会话的槽。**不可变**：每个事件产出新 Map，没变的槽保持同一引用。 */
export type SessionStates = ReadonlyMap<string, SessionEntry>;

export function createSessionStates(): SessionStates {
  return new Map<string, SessionEntry>();
}

/** 空槽是常量：首页/无选中时用它兜底，避免每次渲染新建 TranscriptState。 */
export const EMPTY_ENTRY: SessionEntry = {
  transcript: createTranscriptState(seedSnapshot()),
  window: { firstId: null, hasMore: false, loading: false, compactionsBefore: 0 },
  compactions: [],
  marks: [],
  phase: "idle",
  phaseEpoch: 0,
  queued: [],
  retry: null,
  turnError: null,
  stats: null,
  thinking: null,
  approvals: [],
  fileTurns: [],
  reverts: [],
  undos: [],
  intentRun: null,
  intentRecalls: [],
  intentAsk: null,
  pendingEcho: null,
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
      // 真回显到了：乐观气泡在这一帧换成转录里的正式条目（同款分块，无缝）
      ...(event.progress.type === "item_started" && event.progress.item.role === "user"
        ? { pendingEcho: null }
        : {}),
    }));
  }
  if (event.type === "phase") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      phase: event.phase === "idle" ? "idle" : event.phase === "compaction" ? "compaction" : "turn",
      phaseEpoch: entry.phaseEpoch + 1,
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
      // 乐观回显同理：真回显没来轮就落定 = 它失败了，不留鬼影
      ...(event.phase === "idle" ? { approvals: [], pendingEcho: null } : null),
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
  if (event.type === "fileTurnView") {
    // 轮尾文件账的渲染视图：转成记录形状进槽。盘上那份主进程会铸自己的 id，
    // 重读会话后自然对齐；活会话期这帧就是卡片的数据源。只有旁路网页产物、
    // 没有 changes 的轮也进来（卡片要出）；批量折叠的轮同理——只有计数也进
    const webArtifacts = event.webArtifacts ?? [];
    if (event.changes.length === 0 && webArtifacts.length === 0 && event.webArtifactsBatch === undefined) {
      return states;
    }
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      fileTurns: [
        ...entry.fileTurns,
        {
          role: "file-turn",
          id: event.turnId,
          timestamp: Date.now(),
          changes: event.changes,
          ...(webArtifacts.length > 0 ? { webArtifacts } : {}),
          ...(event.webArtifactsBatch !== undefined ? { webArtifactsBatch: event.webArtifactsBatch } : {}),
        },
      ],
    }));
  }
  if (event.type === "stats") {
    return update(states, event.sessionId, (entry) => ({ ...entry, stats: event.stats }));
  }
  if (event.type === "thinking") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      thinking: {
        providerId: event.providerId,
        modelId: event.modelId,
        level: event.level,
        supported: event.supported,
      },
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
  // 意图系统（实验功能）：流事件归约运行卡、终态记录落桶并收摊运行卡、确认请示挂起
  if (event.type === "intentRecall") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      intentRun:
        entry.intentRun === null || entry.intentRun.turnId !== event.turnId || entry.intentRun.status !== "running"
          ? applyRecallEvent(initialRecallCard(event.turnId, Date.now()), event.event)
          : applyRecallEvent(entry.intentRun, event.event),
    }));
  }
  if (event.type === "intentRecallRecord") {
    return update(states, event.sessionId, (entry) => ({
      ...entry,
      intentRun: null,
      // 同一 turn 重跑只留最后一张（盘上也是这个语义：新记录追加，渲染按 turnId 去尾）
      intentRecalls: [
        ...entry.intentRecalls.filter((record) => record.turnId !== event.record.turnId),
        event.record,
      ],
    }));
  }
  if (event.type === "intentAsk") {
    return update(states, event.sessionId, (entry) => ({ ...entry, intentAsk: event }));
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
        // 厂商原文必存；额度事实有就带上（渲染层据此多一句人话）
        turnError: event.quota === undefined ? { message: event.message } : { message: event.message, quota: event.quota },
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
    ...(phase === "idle" ? { pendingEcho: null } : { turnError: null }),
  }));
}

/**
 * 乐观 turn 的失败归位：提交在 IPC 上失败时把乐观置的 turn 退回 idle——**仅当**提交
 * 以来这个会话没收到过任何 phase 事件（`epochAtSubmit` 是乐观置 turn 那一刻的
 * phaseEpoch）。
 *
 * 收到过就说明 runtime 那边确有一轮在跑（典型：撞 already running——提交被拒，
 * 但占着坑的那一轮的 turn 事件已经先到了），它收尾时的 idle 迟早会来。这时无条件
 * 归位会把真在跑的会话标成空闲：之后每次回车都走直发、撞 already running、
 * 回填快照把字放回输入框——「发出去的字还留在框里」，直到那一轮跑完（2026-09-28
 * CDP 复现）。没收到过就照旧归位：失败发生在 runtime 之前（主进程装配 provider 等），
 * 不会有任何事件来收尾。
 */
export function revertOptimisticTurn(
  states: SessionStates,
  sessionId: string,
  epochAtSubmit: number,
): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || entry.phaseEpoch !== epochAtSubmit) return states;
  return setEntryPhase(states, sessionId, "idle");
}

/**
 * 一段记录按槽分流：模型消息进 pi 的归约器，其余各进各的桶（seedFromDisk 与
 * prependOlder 共用一份分法——两处各写一遍迟早漂移）。
 */
interface SplitRecords {
  items: TranscriptItem[];
  compactions: CompactedRecord[];
  marks: ChannelMarkRecord[];
  fileTurns: FileTurnView[];
  reverts: RevertRecord[];
  undos: UndoRecord[];
  intentRecalls: IntentRecallRecord[];
}

function splitRecords(transcript: readonly SessionRecord[]): SplitRecords {
  const split: SplitRecords = {
    items: [],
    compactions: [],
    marks: [],
    fileTurns: [],
    reverts: [],
    undos: [],
    intentRecalls: [],
  };
  for (const record of transcript) {
    // 内联 role 谓词而非 isCompactedRecord()/isChannelMarkRecord()：本文件被 node --test
    // 加载，@shared 的值导入解析不了（AGENTS.md 硬规则）。
    if (record.role === "user" || record.role === "assistant" || record.role === "tool") {
      split.items.push(record);
    } else if (record.role === "compacted") {
      split.compactions.push(record);
    } else if (record.role === "channel-mark") {
      split.marks.push(record);
    } else if (record.role === "file-turn") {
      // 轮尾账（revert.ts）：卡片层直接消费，剥掉快照正文只留路径与统计
      split.fileTurns.push({
        role: "file-turn",
        id: record.id,
        timestamp: record.timestamp,
        changes: record.changes.map((change) => ({
          path: change.path,
          added: change.added,
          removed: change.removed,
        })),
        // 旁路网页产物随种子还原（旧记录没有这个字段 → 缺席，照常显示）；批量折叠计数同路
        ...(record.webArtifacts !== undefined && record.webArtifacts.length > 0
          ? { webArtifacts: record.webArtifacts }
          : {}),
        ...(record.webArtifactsBatch !== undefined ? { webArtifactsBatch: record.webArtifactsBatch } : {}),
      });
    } else if (record.role === "revert") {
      split.reverts.push(record);
    } else if (record.role === "undo") {
      split.undos.push(record);
    } else if (record.role === "intent-recall") {
      split.intentRecalls.push(record);
    }
  }
  return split;
}

/**
 * 用落盘的 transcript 覆盖一个槽。**整槽覆盖**：历史会话的真相在盘上，
 * 顺带把上次看它时留下的审批清掉——与老实现 `setApprovals([])` 同语义。
 * 活会话**不走这里**：槽里的累积比盘新，种盘等于回退。
 *
 * `page` 是源侧分页的窗口信息（尾部一段 + 外面还有没有更多）；不给就是「这一份
 * 就是全部」——测试与全量种子照旧。窗口的第一条记录 id 由传进来的记录自己算
 * （就是 `loadOlder` 下次要用的 before 锚点）。
 */
export function seedFromDisk(
  states: SessionStates,
  sessionId: string,
  transcript: readonly SessionRecord[],
  stats: AgentStats | null = null,
  page?: { hasMore: boolean; compactionsBefore: number },
): SessionStates {
  // 界碑与通道标记都不进 pi 的归约器（它们不是模型消息，归约器不认识）——分开记账，
  // 显示时由 mergeSideRecords 按时间插回往来流；实时与历史从是同一条显示路径。
  // 文件账三件（revert.ts）同理：轮尾账自成卡片（②/⑤ 接上渲染），回退界碑自成
  // 标记行，撤销只是轮尾卡上的徽标——都不进归约器，也不进 items。
  const { items, compactions, marks, fileTurns, reverts, undos, intentRecalls } = splitRecords(transcript);
  const next = new Map(states);
  next.set(sessionId, {
    transcript: createTranscriptState(seedSnapshot(items)),
    window: {
      firstId: transcript[0]?.id ?? null,
      hasMore: page?.hasMore ?? false,
      loading: false,
      compactionsBefore: page?.compactionsBefore ?? 0,
    },
    compactions,
    marks,
    phase: "idle",
    // 计数只增：同一会话重新种盘也不回零，免得撞上某个提交前记下的旧值
    phaseEpoch: states.get(sessionId)?.phaseEpoch ?? 0,
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
    fileTurns,
    reverts,
    undos,
    // 同一 turn 重跑只留最后一张（重读盘后与实时事件的去重口径一致）
    intentRecalls: dedupeRecalls(intentRecalls),
    intentRun: null,
    intentAsk: null,
    pendingEcho: null,
  });
  return next;
}

/** 同一 turnId 只留最后一张（重跑 recall 会追加新记录）。 */
function dedupeRecalls(records: readonly IntentRecallRecord[]): IntentRecallRecord[] {
  const lastOf = new Map<string, IntentRecallRecord>();
  for (const record of records) lastOf.set(record.turnId, record);
  return records.filter((record) => lastOf.get(record.turnId) === record);
}

/** 槽里已经装着哪些记录 id（prependOlder 的去重根据） */
function loadedIds(entry: SessionEntry): Set<string> {
  const ids = new Set<string>();
  for (const item of entry.transcript.snapshot.transcript) ids.add(item.id);
  for (const id of entry.transcript.progressItems.keys()) ids.add(id);
  for (const record of entry.compactions) ids.add(record.id);
  for (const record of entry.marks) ids.add(record.id);
  for (const record of entry.fileTurns) ids.add(record.id);
  for (const record of entry.reverts) ids.add(record.id);
  for (const record of entry.undos) ids.add(record.id);
  for (const record of entry.intentRecalls) ids.add(record.id);
  return ids;
}

/**
 * 把更早的一页并到槽的**前面**（源侧分页向前的方向，`session:loadOlder` 的回执）。
 *
 * - **前半部分拼接**：只往已加载窗口之前放记录，尾部的实时累积（progress 条目、
 *   审批、队列）一个字不动——流式只发生在尾部，两件事正交。这里也因此直接改
 *   `snapshot.transcript`（pi 的归约器只在种盘时建它，之后靠 progress 事件追加）：
 *   重建 TranscriptState 会把流式中间态（progressItems / toolCallBuffers）洗掉。
 * - **去重**：重试 / 并发拉回同一页时按记录 id 丢掉已有的（同一页里重复的也丢），
 *   否则 React 会在同一列里看到两个同 key 的单元。
 * - **锚点跟着页往前移**：firstId = 这一页的头一条，下一次 loadOlder 拿它当 before。
 *   对不上盘（会话在途中被回退）时主进程回空页 + hasMore=false，锚点保持不动。
 * - 槽不在了（会话被删 / 切到首页）就什么都不做：不凭空造一个只有历史的槽。
 */
export function prependOlder(
  states: SessionStates,
  sessionId: string,
  records: readonly SessionRecord[],
  page: { hasMore: boolean },
): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined) return states;
  const known = loadedIds(entry);
  const fresh: SessionRecord[] = [];
  for (const record of records) {
    if (known.has(record.id)) continue;
    known.add(record.id);
    fresh.push(record);
  }
  const older = splitRecords(fresh);
  const transcript: TranscriptState = {
    snapshot: {
      ...entry.transcript.snapshot,
      transcript: [...older.items, ...entry.transcript.snapshot.transcript],
    },
    progressItems: entry.transcript.progressItems,
    progressOrder: entry.transcript.progressOrder,
    toolCallBuffers: entry.transcript.toolCallBuffers,
  };
  return new Map(states).set(sessionId, {
    ...entry,
    transcript,
    compactions: [...older.compactions, ...entry.compactions],
    marks: [...older.marks, ...entry.marks],
    fileTurns: [...older.fileTurns, ...entry.fileTurns],
    reverts: [...older.reverts, ...entry.reverts],
    undos: [...older.undos, ...entry.undos],
    // older 在前、已有的在后：同一 turn 重跑时后面的（更新的）那张赢，同种盘语义
    intentRecalls: dedupeRecalls([...older.intentRecalls, ...entry.intentRecalls]),
    window: {
      firstId: fresh[0]?.id ?? entry.window.firstId,
      hasMore: page.hasMore,
      loading: false,
      // 这页里的界碑已经进了 compactions：从「窗口之前」的数里挪走，总数不变
      compactionsBefore: Math.max(0, entry.window.compactionsBefore - older.compactions.length),
    },
  });
}

/**
 * 会话一共压缩过几次 = 已加载窗口里的界碑 + 窗口之前的界碑。
 * 回退折叠在主进程做完了，这里数到的就是当前生效视图的口径。
 */
export function compactionCount(entry: Pick<SessionEntry, "compactions" | "window">): number {
  return entry.compactions.length + entry.window.compactionsBefore;
}

/**
 * 标记「更早的一页在途」。写入前先看槽：不在 / 已经在途就不动（返回值不变引用，
 * 不白激一次渲染）。hook 在发请求前调它——它是防重的唯一根据（快速连续触顶只发一次）。
 */
export function setOlderLoading(states: SessionStates, sessionId: string, loading: boolean): SessionStates {
  const entry = states.get(sessionId);
  if (entry === undefined || entry.window.loading === loading) return states;
  return new Map(states).set(sessionId, {
    ...entry,
    window: { ...entry.window, loading },
  });
}

/**
 * 视图合成：界碑、通道标记、轮尾账与回退界碑都按发生位置插回往来流。**历史
 * 一条不少地保持可见**——被收进「已压缩」折叠行的是摘要本身（它才是混进对话的
 * 内部消息），不是压缩点之前的往来。pi 的「边界前隐藏」语义在这里被用户裁决否决：
 * 可追溯是产品底线，pi 的做法照搬错了对象。
 *
 * 原名 `mergeCompactions`（子会话 PR4a 推广）：通道标记与界碑同一处境——都不进
 * pi 的归约器，都要按 timestamp 插回 transcript——没有必要另开一份并行逻辑。
 * 轮尾账 / 回退界碑（会话回退）同理加入。
 */
export function mergeSideRecords(
  compactions: readonly CompactedRecord[],
  marks: readonly ChannelMarkRecord[],
  fileTurns: readonly FileTurnView[],
  reverts: readonly RevertRecord[],
  undos: readonly UndoRecord[],
  transcript: readonly TranscriptItem[],
  intentRecalls: readonly IntentRecallRecord[] = [],
): TranscriptRecord[] {
  if (
    compactions.length === 0 &&
    marks.length === 0 &&
    fileTurns.length === 0 &&
    reverts.length === 0 &&
    undos.length === 0 &&
    intentRecalls.length === 0
  ) {
    return [...transcript];
  }
  const records: TranscriptRecord[] = [
    ...transcript,
    ...compactions,
    ...marks,
    ...fileTurns,
    ...reverts,
    ...undos,
    ...intentRecalls,
  ];
  // 同毫秒排序（混排靠落盘时间戳定序，同刻时给确定序）：
  // - 界碑 / 通道标记 / 轮尾账 / 回退界碑（side 记录）排在前——界碑要落到
  //   「刚发那句」之前的老规则；
  // - 意图召回卡是唯一的例外：它服务的那条 user 回显与它几乎必然同毫秒
  //   （回显循环后立刻进闸门），按老规则会排到气泡**上方**（2026-10-13 真机），
  //   给它单独一档排在同刻的最后——正好落在它服务的气泡之后、回答之前。
  const sameMsRank = (record: TranscriptRecord): number => {
    if (record.role === "intent-recall") return 2;
    if (record.role === "user" || record.role === "assistant" || record.role === "tool") return 1;
    return 0; // 界碑 / 通道标记 / 轮尾账 / 回退界碑：老规则，同刻在前
  };
  records.sort((a, b) => a.timestamp - b.timestamp || sameMsRank(a) - sameMsRank(b));
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

/** 按 requestId 跨槽摘掉挂起的意图确认请示。没有匹配就原样返回（同一引用）。 */
export function removeIntentAsk(states: SessionStates, requestId: string): SessionStates {
  for (const [sessionId, entry] of states) {
    if (entry.intentAsk?.requestId !== requestId) continue;
    const next = new Map(states);
    next.set(sessionId, { ...entry, intentAsk: null });
    return next;
  }
  return states;
}

/** 发出即画：记下乐观回显的正文块（与 runtime 的回显同款切法）。 */
export function setPendingEcho(states: SessionStates, sessionId: string, blocks: readonly string[]): SessionStates {
  return update(states, sessionId, (entry) => ({ ...entry, pendingEcho: { blocks } }));
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
