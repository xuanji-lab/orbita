/**
 * 记忆系统（实验功能 memory-system）的契约真源。
 *
 * 设计取向（QUMem + AtomMem + Mandol 的调研结论，细节见各 commit message）：
 * - **按事件段整理**：对话不是按轮、而是按「同一件事的连续轮次」（事件段 / episode）
 *   切开，每收尾一段用家务活模型做恰好三次调用，拆成三类可独立检索的原子记忆：
 *   事实（发生过的事，不推断）、偏好（选择 / 倾向 / 约束，带理由）、经验（可迁移的
 *   做事原则，必须挂具体交互证据）。
 * - **每条自包含**：第三人称、消指代、相对时间换算成绝对日期（AtomMem 的原子化
 *   ≡ Mandol 的自包含改写），召回是词法的，条目质量就是召回质量的全部来源。
 * - **冲突只给建议**：新偏好可能与旧偏好矛盾时打 conflictWith，**写入时不改旧条目**，
 *   拍板权在用户（后续界面 PR 的写入口）。
 * - **记忆核心在独立进程**（Electron utilityProcess，与 agent 进程同级）：存储、
 *   打分、事件段状态机都在那边；以后经 MCP 开放给别的 agent、向量模型也由它统一管。
 *
 * 本 PR 只做 Orbita 内部这一个消费者：主进程 ↔ 记忆服务的消息协议在这里，
 * agent ↔ 主进程的召回问答（memoryRecallRequest / memoryRecallResult）在
 * agent-ipc.ts（与 readTaskRequest 同一条 requestId 边界）。
 */
import type { ProviderSecrets } from "./agent-ipc.ts";

/* ---------- 条目 ---------- */

/** 原子记忆的三类（QUMem 的分类法）。 */
export type MemoryEntryType = "fact" | "preference" | "insight";

/**
 * 条目来源。联合类型是给以后的摘抄（excerpt）/ 外部 agent 并入留的扩展位——
 * **只放已有消费者的成员**，本 PR 只有 chat（对话整理）。
 */
export type MemorySource = "chat";

/**
 * 条目状态。召回只认 active；muted = 用户在记忆库里关掉的（写入口在后续界面 PR，
 * 盘上已能表达，召回侧先按它过滤）。
 */
export type MemoryStatus = "active" | "muted";

/** 存放层：user = 所有工作区共享；workspace = 单个作用域（带 scopeId）。 */
export type MemoryLayer = "user" | "workspace";

/** 一条原子记忆。 */
export interface MemoryEntry {
  /** `mem_` 前缀的 uuid（记忆服务落盘时分配，提取侧不造 id） */
  id: string;
  type: MemoryEntryType;
  /** 自包含、第三人称、时间绝对的陈述句 */
  text: string;
  /** 偏好的理由 / 经验的依据（挂的具体交互证据）；事实可空 */
  reason?: string;
  /** 提取时模型给的检索词（≤8 个），词法召回的主信号 */
  keywords: string[];
  layer: MemoryLayer;
  /** layer = workspace 时必带：作用域 id（memoryScopeOf 的口径） */
  scopeId?: string;
  /** 出处会话 */
  sessionId: string;
  /** 支撑这条记忆的轮号（按用户消息计，1 起），升序去重 */
  turns: number[];
  /** 最新支撑轮的用户消息时间（epoch ms）——条目的时间位置 */
  at: number;
  /** 所属事件段（episodeId，见 MemoryEpisode） */
  episodeId: string;
  source: MemorySource;
  /** 缺席 = active */
  status?: MemoryStatus;
  /** 建议升到所有工作区：跨工作区通用的偏好，写在工作区层等用户拍板（后续界面 PR） */
  pendingPromote?: true;
  /** 可能与哪条旧偏好冲突（那条的 id）。只给建议，不改旧条目 */
  conflictWith?: string;
}

/** 召回命中：条目 + 归一化分（0..1，含时间衰减）；pinned = 常驻直通（不打分）。 */
export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
  pinned?: boolean;
}

/**
 * memoryRecallRequest 的回执载荷（readTaskResult 同款 ok 双分支，挂在
 * agent-ipc.ts 的 memoryRecallResult 上）。空库 / 无命中也是 ok: true 配空
 * hits——「没东西可注入」不是错误；服务不在 / 超时 / 出错才走 ok: false。
 */
export type MemoryRecallOutcome =
  | { ok: true; hits: MemoryHit[] }
  | { ok: false; error: string };

/* ---------- 事件段（episode） ---------- */

/** 事件段里一轮的原文快照（已截断：用户话取头部、助手话取尾部）。 */
export interface MemoryEpisodeTurn {
  /** 轮号（按用户消息计，1 起） */
  turn: number;
  /** 该轮用户消息时间（epoch ms） */
  at: number;
  /** 用户话（头部截断，MEMORY_USER_SNAPSHOT_CHARS） */
  userText: string;
  /** 助手话（尾部截断，MEMORY_ASSISTANT_SNAPSHOT_CHARS——结论往往在尾巴上） */
  assistantText: string;
}

/** 事件段：一段「同一件事」的连续轮次，提取的最小单元。 */
export interface MemoryEpisode {
  /** `ep_` 前缀的 uuid */
  episodeId: string;
  sessionId: string;
  /** 段内轮号区间（含两端；单轮段两端相等） */
  fromTurn: number;
  toTurn: number;
  openedAt: number;
  lastAt: number;
  /** 每轮的原文快照（提取的输入；界面展示段原文也用它） */
  turns: readonly MemoryEpisodeTurn[];
}

/* ---------- 作用域与快照 ---------- */

/**
 * 会话归属的记忆作用域：**工作区优先，没有工作区才退回 cwd**。哪两条会话共享
 * 记忆由它决定——放在契约里，主进程与记忆服务用同一个口径。
 */
export function memoryScopeOf(meta: { workspaceId: string | null; cwd: string }): string {
  return meta.workspaceId ?? meta.cwd;
}

/** 快照截断上限（#228 实测口径：用户话取头、助手话取尾）。 */
export const MEMORY_USER_SNAPSHOT_CHARS = 4000;
export const MEMORY_ASSISTANT_SNAPSHOT_CHARS = 8000;

/** 一轮 → 快照：用户话取头部、助手话取尾部并截断。发送侧（主进程）先截，IPC 不传整轮。 */
export function memoryTurnSnapshot(input: {
  turn: number;
  at: number;
  userText: string;
  assistantText: string;
}): MemoryEpisodeTurn {
  return {
    turn: input.turn,
    at: input.at,
    userText: input.userText.slice(0, MEMORY_USER_SNAPSHOT_CHARS),
    assistantText:
      input.assistantText.length <= MEMORY_ASSISTANT_SNAPSHOT_CHARS
        ? input.assistantText
        : `……（中段略）${input.assistantText.slice(-MEMORY_ASSISTANT_SNAPSHOT_CHARS)}`,
  };
}

/* ---------- 注入账本 ---------- */

/**
 * 一轮的注入记录（`memory/injections.jsonl` 一行一条，只追加）。**每轮都落一条
 * （包括零命中）**——它是审查面板「本轮用到了哪些记忆」的地基（界面在后续 PR），
 * 零命中的轮也要能说出「这轮没有注入」。
 */
export interface MemoryInjectionRecord {
  sessionId: string;
  /** 第几轮（按用户消息计，1 起） */
  turn: number;
  /** 开轮时刻（epoch ms） */
  at: number;
  /** 注入的条目与分数（常驻在内，score = 1）；空数组 = 这轮没注入 */
  hits: readonly { id: string; score: number; pinned?: boolean }[];
}

/* ---------- 主进程 ↔ 记忆服务进程的消息协议 ---------- */

/**
 * 家务活模型（切段分类与三类提取都用它）：主进程装配好的密钥面（choreComplete
 * 同款——agent / 记忆服务进程不碰 secrets 文件）。缺席 = 没配，不构建。
 */
export interface MemoryChoreModel {
  provider: ProviderSecrets;
  modelId: string;
}

/** 主进程 → 记忆服务。 */
export type MemoryServiceCommand =
  /**
   * 进程就绪后的第一句：数据目录与当前的家务活模型（启动时就有待提取的旧段，
   * 要它才开工）。chore 缺席时旧段挂起，等下一次 turnSettled 带来模型再提。
   */
  | { type: "init"; dir: string; chore?: MemoryChoreModel }
  /**
   * 一轮正常落定（只限根会话的用户原话，主进程已判）。加入该会话的未收尾事件段：
   * 服务侧先判「与上一轮是否同一件事」（家务活模型的短二分类，chore 缺席时整条
   * 链路不动、只留日志），判新事件就收尾上一段并触发三次提取调用。
   */
  | {
      type: "turnSettled";
      sessionId: string;
      scopeId: string;
      /** 轮号（按用户消息计，1 起） */
      turn: number;
      /** 该轮用户消息时间（epoch ms） */
      at: number;
      userText: string;
      assistantText: string;
      /** 当前装配好的家务活模型；每次随轮现送（设置改了下一轮就生效） */
      chore?: MemoryChoreModel;
    }
  /**
   * 每轮开始前的召回（所有会话都问，含子会话——子会话读不写）。合并「user 层 +
   * 当前工作区层」，常驻直通 + 词法打分；服务侧落一条注入记录（含零命中）。
   */
  | {
      type: "recall";
      requestId: string;
      sessionId: string;
      scopeId: string;
      turn: number;
      query: string;
    };

/** 记忆服务 → 主进程。 */
export type MemoryServiceMessage =
  | { type: "ready" }
  /**
   * recall 的回执。服务内部出问题时也回空 hits（召回失败 ≠ 错误，开轮不该被拦）；
   * 主进程侧另有超时兜底。
   */
  | { type: "recallResult"; requestId: string; hits: MemoryHit[] };
