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
 * - **agent 自己判断、结果直接生效**（2026-10-29 晚用户裁决，推翻上午的「冲突只给建议、
 *   升层与冲突要用户确认」）：提取判出新偏好与旧偏好矛盾 → 旧条直接标 stale、新条带
 *   conflictWith 指过去；判出跨工作区通用 → 直接落 user 层、promotedFrom 记原作用域。
 *   对话里用户一句话纠错 → agent 用记忆工具（memory_revise / memory_retire）当场改。
 *   没有「待你确认」队列；每一步都能在条目卡上撤销，演变链里看得到。
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
 * 条目来源。**只放已有消费者的成员**：chat（对话整理）、manual（记忆库手动添加）、
 * agent（对话里 agent 用 memory_revise 按用户纠正写下的新说法——出处是那条会话
 * 那一轮，没有事件段）。
 */
export type MemorySource = "chat" | "manual" | "agent";

/**
 * 条目状态。召回只认 active：muted = 不再使用（用户关掉的，或 agent 用 memory_retire
 * 停用的）；stale = 被新说法顶掉的旧条（提取判出冲突、或 agent 修订）——不进召回，
 * 但在演变链里仍可见。
 */
export type MemoryStatus = "active" | "muted" | "stale";

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
  /** 停用理由：agent 用 memory_retire 停用时给的话（条目卡上原样显示），或保留值
   * MEMORY_MUTED_REVERTED（随对话回退自动停用，条目卡显示为标签）。恢复使用时清掉 */
  mutedReason?: string;
  /** 提取判出跨工作区通用、自动升到 user 层前的原作用域 token。存在 = 条目卡给
   * 「只留在原工作区」（returnToWorkspace 按它搬回；sha1 单向回不出 scopeId，寻址本来就是 token） */
  promotedFrom?: string;
  /** 顶掉了哪条旧条目（那条的 id；旧条此时是 stale）。沿它串出演变链；条目卡给
   * 「恢复旧说法」（restorePrevious） */
  conflictWith?: string;
  /** 上次编辑时间（epoch ms）。缺席 = 没编辑过 */
  editedAt?: number;
}

/**
 * mutedReason 的保留值：用户在对话里「回到这里」撤回了这条的全部来源轮，记忆服务随之
 * 停用它（sessionReverted）。条目卡认出它就显示「随对话回退停用」标签、不当原因原文；
 * 「恢复使用」照常清掉。agent 的 memory_retire 理由是给人看的句子，撞不上这个词。
 */
export const MEMORY_MUTED_REVERTED = "reverted";

/**
 * 条目 id 的短形（召回块与记忆工具的输出里用它）：`mem_` + uuid 头 8 位。记忆服务
 * 按前缀反查，同一可见范围（user 层 + 当前工作区层）里撞了前缀就报歧义，不猜。
 */
export function memoryShortId(id: string): string {
  return id.slice(0, 12);
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

/**
 * agent 的记忆工具（memory_search / memory_revise / memory_retire）的一次调用。
 * 只在根会话注册（子会话读不写）；可见范围恒为「user 层 + 本会话作用域层」，
 * 别的工作区的记忆不可查也不可改。entryId 可以是全 id 或 memoryShortId 的短形。
 */
export type MemoryAgentCall =
  /** 按问题检索（只看 active 条目） */
  | { op: "search"; query: string }
  /** 用户纠正了某条：旧条标 stale，写一条 source = agent 的新条，conflictWith 指旧条 */
  | { op: "revise"; entryId: string; text: string; reason: string }
  /** 这条根本不对、也没有新说法：标 muted，记下理由 */
  | { op: "retire"; entryId: string; reason: string };

/**
 * 记忆工具的回执。entries 的含义按 op：search = 命中（相关度序）；revise = [新条, 旧条]；
 * retire = [被停用的那条]。失败带一句给模型看的人话（找不到 / 歧义 / 子会话不能写）。
 */
export type MemoryAgentOutcome =
  | { ok: true; entries: MemoryEntry[] }
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
  /** 段发生时的作用域（提取落在这一层） */
  scopeId: string;
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
  /** 注入的条目与分数（常驻在内，score = 1）；空数组 = 这轮没注入。
   * text 是注入时刻的正文快照（新行必带；可选只是客忍旧实验数据——条目后来
   * 被编辑 / 删除，面板上仍要能看到当时注入了什么） */
  hits: readonly { id: string; text?: string; score: number; pinned?: boolean }[];
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
   * 用户在对话里「回到这里」：第 fromTurn 轮（按用户消息计，1 起）及之后的轮被撤回，
   * 下一条用户消息的轮号就是 fromTurn。服务侧：该会话开段 / 待提取段里轮号 ≥ fromTurn
   * 的轮截掉（截空的段丢弃），开段水位回到 fromTurn − 1，之后的新轮照常并入；本会话
   * 「来源轮全部 ≥ fromTurn」的条目停用（mutedReason = MEMORY_MUTED_REVERTED），它们
   * 当初顶掉的旧条恢复 active。只限根会话（子会话不写记忆，主进程不发）。无回执。
   */
  | { type: "sessionReverted"; sessionId: string; fromTurn: number }
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
    }
  /**
   * 记忆库的写操作（唯一写者在服务：与提取共用写盘代码，也避免两进程同写一个
   * 文件）。回执 mutateResult；任何写盘后另发一条 changed。
   */
  | { type: "mutate"; requestId: string; mutation: MemoryMutation }
  /**
   * agent 记忆工具的一次调用（主进程已判根会话、已按会话解好 scopeId）。回执
   * agentToolResult；写了盘另发 changed。sessionId / turn 是 revise 新条的出处。
   */
  | {
      type: "agentTool";
      requestId: string;
      sessionId: string;
      scopeId: string;
      turn: number;
      call: MemoryAgentCall;
    }
  /**
   * 向量召回的运行配置：null = 关（停 llama-server、暂停补算）。设置改了
   * 下一份立即生效（换模型 = manifest 不符 → 清库重算，服务自行触发补算）。
   */
  | { type: "setVectorConfig"; config: MemoryVectorServiceConfig | null }
  /** 电池状态变化（powerMonitor 在主进程）：onBattery 时推迟批量补算 */
  | { type: "setPower"; onBattery: boolean }
  /** 拉服务的运行态（设置页 status 用）。回执 vectorStateResult。 */
  | { type: "vectorState"; requestId: string }
  /**
   * 下载模型文件（服务 owns <userData>/vector/）：流式下载 + sha256 校验，
   * 进度经 downloadProgress 事件推。已在下载中幂等回 ok。
   */
  | {
      type: "startModelDownload";
      requestId: string;
      /** 依序尝试的下载源（HF 直连在前，hf-mirror 兜底） */
      sources: readonly string[];
      targetPath: string;
      sha256: string;
      sizeBytes: number;
    }
  /**
   * 停机（开关关 / 应用退出）：服务停 llama-server、取消下载后自行退出。
   * 主进程发完不等回执（退出路上等不起），紧接着按 embedServerPid 补杀引擎、再 kill
   * 服务进程——这条命令是「来得及就优雅」的那一层，不是唯一一层。
   */
  | { type: "shutdown" };

/** 记忆服务 → 主进程。 */
export type MemoryServiceMessage =
  | { type: "ready" }
  /**
   * recall 的回执。服务内部出问题时也回空 hits（召回失败 ≠ 错误，开轮不该被拦）；
   * 主进程侧另有超时兜底。
   */
  | { type: "recallResult"; requestId: string; hits: MemoryHit[] }
  /**
   * mutate 的回执（memory 库的写操作；服务是唯一写者，见 MemoryMutation）。
   * 目标条目不在 / 入参不合法时 ok: false。
   */
  | ({ type: "mutateResult"; requestId: string } & MemoryMutationOutcome)
  /** agentTool 的回执（服务不在 / 超时由主进程兜成 ok:false） */
  | ({ type: "agentToolResult"; requestId: string } & MemoryAgentOutcome)
  /** vectorState 的回执（设置页 status 的服务侧那部分） */
  | {
      type: "vectorStateResult";
      requestId: string;
      llamaRunning: boolean;
      backfill: { state: "running" | "deferred-battery"; done: number; total: number } | null;
      vectors: MemoryVectorsSummary | null;
    }
  /** 模型下载进度（流式；downloading/verifying/done/failed） */
  | { type: "downloadProgress"; progress: MemoryDownloadProgress }
  /** 后台补算进度（running / deferred-battery / idle 收尾） */
  | { type: "backfillProgress"; progress: MemoryBackfillProgress }
  /**
   * llama-server 的 pid（拉起时报数字、退出时报 null）。主进程记下来，在停服务 /
   * 服务崩溃时按 pid 补杀：Windows 上 UtilityProcess.kill() 是 TerminateProcess，
   * 服务来不及清理自己的子进程；macOS 上服务崩溃同样会把它留成孤儿。
   */
  | { type: "embedServerPid"; pid: number | null }
  /**
   * init 失败（数据目录读不了等）。主进程停掉这个服务并记住失败，不再每轮重拉；
   * 实验开关关了再开（或重启应用）才重试。
   */
  | { type: "initFailed"; error: string }
  /**
   * 任何写盘之后发一次（提取落条目、事件段收尾 / 归档、记忆库写操作）：主进程
   * 接到后广播给窗口（agent:event 的 memoryChanged），界面重拉。无载荷——
   * 谁变了、变成了什么由拉取方自己看。
   */
  | { type: "changed" };

/* ---------- 记忆库的读写面（renderer ↔ 主进程，四层契约的读接口） ---------- */

/**
 * 作用域的寻址 token（#228 的口径）：`"user"`（所有工作区层）或 40 位 hex
 * （workspace 层 = sha1(scopeId)）。renderer 拿到哪条条目的 token 就带回来寻址。
 */
export type MemoryScopeToken = string;

/** user 层的 token 保留字（不与 sha1 撞名）。 */
export const MEMORY_USER_TOKEN = "user";

/** 记忆库左栏 / 范围选择的一行。 */
export interface MemoryScopeSummary {
  token: MemoryScopeToken;
  kind: "user" | "workspace" | "home";
  /** 显示名：所有工作区 / 工作区名 / Home（多个 Home 带短 token 后缀区分） */
  name: string;
  /** 条数 */
  count: number;
}

/** 偏好演变链的一个节点（沿 conflictWith 串起来的新旧条目，按时间旧 → 新）。 */
export interface MemoryEvolutionNode {
  id: string;
  text: string;
  at: number;
  /** 缺席 = active；stale 的节点界面要标注「已过时」 */
  status?: MemoryStatus;
  /** agent 修订的节点界面要标注出来（用户要能看出「这是 agent 按我的话改的」） */
  source: MemorySource;
}

/** 记忆库 / 审查页签里的一条条目（装配后的视图行）。 */
export interface MemoryEntryView {
  entry: MemoryEntry;
  /** 所在作用域（改动 / 删除要带回来寻址） */
  token: MemoryScopeToken;
  /** 出处会话标题；null = 会话已删 / manual 手动添加 */
  sessionTitle: string | null;
  /** 原话片段：最新支撑轮的用户原文头部（事件段快照截取）；manual 为 null */
  quote: string | null;
  /** 偏好演变链（含自身，旧 → 新）；无冲突关联为空数组 */
  evolution: readonly MemoryEvolutionNode[];
}

/** 条目列表请求：token = "all" 读全部层；type 缺席 = 不过滤。 */
export interface MemoryEntriesRequest {
  token: "all" | MemoryScopeToken;
  type?: MemoryEntryType;
}

export type MemoryEntriesResponse = { items: MemoryEntryView[] };

/** 某会话按轮的「用到」一行（注入时刻的快照）。 */
export interface MemoryUsedHit {
  id: string;
  /** 注入时刻的正文快照；旧实验数据的行没有时回当前条目正文 */
  text: string;
  score: number;
  pinned?: boolean;
}

/** 审查面板 › 记忆页签里的一轮。 */
export interface MemorySessionTurnView {
  turn: number;
  /** 开轮时刻（epoch ms） */
  at: number;
  /** 用到：本轮注入的条目快照（含零命中轮的空数组） */
  used: readonly MemoryUsedHit[];
  /** 记住：这一轮支撑落下的新条目（该会话条目里 turns 含此轮的，含 agent 当场修订的），
   * 带所在层 token 与演变链——条目卡要能撤销 */
  remembered: readonly MemoryEntryView[];
}

/** 某会话的按轮记忆视图（对话里的「记忆 · 记住 M 条」行与审查 › 记忆页签共用）。 */
export interface MemorySessionView {
  sessionId: string;
  /** 会话作用域的 token（改动寻址用）；meta 读不到为 null（新会话首轮等） */
  token: MemoryScopeToken | null;
  /** 轮集合 = 注入账本 ∪ 本会话新增条目的轮；轮间新在前 */
  turns: readonly MemorySessionTurnView[];
}

/* ---------- 记忆库的写操作（renderer → 主进程 → 记忆服务，唯一写者） ---------- */

/**
 * 记忆库的写操作。**执行在记忆服务进程**（它与提取共用一套写盘代码，也避免
 * 两进程同写一个文件）；主进程只做入参校验与转发。没有拍板类操作——冲突与升层
 * 由 agent 判断后直接生效，这里只有撤销（restorePrevious / returnToWorkspace）。
 */
export type MemoryMutation =
  | {
      /** 改正文（trim 后非空才生效）；盖 editedAt */
      op: "edit";
      token: MemoryScopeToken;
      entryId: string;
      text: string;
    }
  | {
      /** 删一条（幂等：不在了也回 ok） */
      op: "remove";
      token: MemoryScopeToken;
      entryId: string;
    }
  | {
      /** 状态开关：muted = 这条别再用；active = 解除。stale 只由新说法顶掉旧说法产生 */
      op: "setStatus";
      token: MemoryScopeToken;
      entryId: string;
      status: "active" | "muted";
    }
  | {
      /** 手动添加（落在指定作用域）：type + 正文；偏好 / 经验必须带 reason。
       * scopeId 由主进程能解到就填（工作区表反查 token），解不出省略——
       * 寻址靠 token，scopeId 只是展示参考 */
      op: "addManual";
      token: MemoryScopeToken;
      type: MemoryEntryType;
      text: string;
      reason?: string;
      scopeId?: string;
    }
  | {
      /** 撤销一次「新说法顶掉旧说法」（提取判出的冲突或 agent 修订）：entryId 是新条，
       * 它 conflictWith 指的旧条恢复 active，新条标 muted（不删——演变链照常可见；
       * 用户再「恢复使用」新条就是两条都留） */
      op: "restorePrevious";
      token: MemoryScopeToken;
      entryId: string;
    }
  | {
      /** 撤销自动升层：user 层里带 promotedFrom 的条目搬回原作用域，promotedFrom 清掉 */
      op: "returnToWorkspace";
      token: MemoryScopeToken;
      entryId: string;
    };

/** mutate 的回执：改动后的条目（remove / 目标不在为 null），失败带一句人话。 */
export type MemoryMutationOutcome =
  | { ok: true; entry: MemoryEntry | null }
  | { ok: false; error: string };

/* ---------- 向量召回（本地模型：llama-server + GGUF） ---------- */

/**
 * 本地向量模型登记表。sha256 是 HuggingFace LFS oid（就是文件内容哈希），
 * 下载后本地校验；参数是选型报告（e19bf631 工作台，2026-10-29）§4 的实测值。
 * 加模型 = 加一行；升级 llama.cpp / 换 GGUF 版本改表并整库重算。
 */
export interface MemoryVectorModel {
  /** 设置与 manifest 里的模型标识 */
  id: "embeddinggemma-2" | "qwen3-embedding-0.6b";
  /** HF 仓库名（gguf 文件在 repo 下；hf-mirror 备用源同路径） */
  repo: string;
  /** GGUF 文件名（下载到 <userData>/vector/<文件名>） */
  file: string;
  sha256: string;
  sizeBytes: number;
  /** llama-server --pooling；null = GGUF 自带 */
  pooling: "mean" | "last" | "cls" | null;
  ctx: number;
  /** 查询前缀（嵌入用户 query 时拼前面） */
  queryPrefix: string | null;
  /** 文档前缀（嵌入条目正文时拼前面） */
  docPrefix: string | null;
  dims: number;
  /**
   * 向量臂的余弦下限：低于它的条目不进 RRF 融合。没有下限时余弦 top-50 全量进融合，
   * 问什么都能召回满 5 条（与记忆库毫不相干的问句也注入 5 条）。各模型的余弦尺度
   * 不同（无关问句 gemma 落 0.60–0.64、qwen3 落 0.2–0.4），所以按模型给值；
   * 数值来自真实记忆的门槛评测，见引入本字段的 commit 正文。
   */
  minCosine: number;
}

export const MEMORY_VECTOR_MODELS: readonly MemoryVectorModel[] = [
  {
    id: "embeddinggemma-2",
    repo: "ggml-org/embeddinggemma-2-GGUF",
    file: "embeddinggemma-2-Q8_0.gguf",
    sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
    sizeBytes: 309_855_456,
    pooling: "mean",
    ctx: 8192,
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
    dims: 768,
    minCosine: 0.655,
  },
  {
    id: "qwen3-embedding-0.6b",
    repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    sizeBytes: 639_150_592,
    pooling: "last",
    ctx: 8192,
    queryPrefix:
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
    docPrefix: null,
    dims: 1024,
    minCosine: 0.42,
  },
];

/** 设备状态（主进程探测：powerMonitor + os；「向量模型」设置页的分档提示用）。 */
export interface MemoryDeviceStatus {
  /** 芯片 / CPU 型号（os.cpus()[0].model） */
  chip: string;
  /** 内存（GB，取整） */
  memoryGb: number;
  onBattery: boolean;
  platform: string;
  arch: string;
  /** 按 8GB 线分档（选型报告 §5）：cloud = 建议云端（后续版本），界面只做推荐文案 */
  recommend: "local" | "cloud";
}

/** 模型文件的就地状态（下载进度从服务的事件来，status 拉取时合并最近值）。 */
export type MemoryModelFileState =
  | { state: "none" }
  | { state: "downloading"; received: number; total: number; source: string }
  | { state: "verifying" }
  | { state: "ready"; sizeBytes: number }
  | { state: "failed"; error: string };

/** 向量库（manifest + 行数）的摘要；null = 还没向量化过。 */
export interface MemoryVectorsSummary {
  model: string;
  dims: number;
  /** 已有向量的条目数（各层之和） */
  entries: number;
}

/** 「向量模型」设置页一次拉全的快照。 */
export interface MemoryVectorStatus {
  /** 设置生效值（默认已并入） */
  settings: MemoryVectorSettings;
  device: MemoryDeviceStatus;
  /** llama-server 二进制备取结果（安装包 / 开发目录 / 环境变量） */
  llamaServer: { found: boolean; path: string | null; source: "packaged" | "dev" | "env" | null };
  modelFile: MemoryModelFileState;
  /** 后台补算进度；null = 没在算也不欠账 */
  backfill: { state: "running" | "deferred-battery"; done: number; total: number } | null;
  vectors: MemoryVectorsSummary | null;
}

/** 向量召回的全默认值（AppSettings.vector 缺席时生效：关 + gemma-2 + 5 分钟卸载 + 电池推迟）。 */
export const DEFAULT_MEMORY_VECTOR_SETTINGS: MemoryVectorSettings = {
  mode: "off",
  model: "embeddinggemma-2",
  idleUnloadMin: 5,
  deferOnBattery: true,
};

/** 设置里的向量召回偏好（AppSettings.vector；缺席全默认 = 关）。 */
export interface MemoryVectorSettings {
  /** off = 关（默认）；local = 本地向量。云端兜底是后续版本，枚举留扩展位 */
  mode: "off" | "local";
  model: MemoryVectorModel["id"];
  /** llama-server 空闲多久卸载（分钟） */
  idleUnloadMin: number;
  /** 用电池时推迟批量补算（默认 true；交互召回不受影响——单查毫秒级） */
  deferOnBattery: boolean;
}

/** 下载进度事件（服务 → 主进程 → agent:event 的 vectorDownload）。 */
export interface MemoryDownloadProgress {
  requestId: string;
  phase: "downloading" | "verifying" | "done" | "failed";
  source: string;
  received: number;
  total: number;
  error?: string;
}

/** 补算进度事件（服务 → 主进程 → agent:event 的 vectorBackfill）。 */
export interface MemoryBackfillProgress {
  state: "running" | "idle" | "deferred-battery";
  done: number;
  total: number;
}

/** 主进程 → 服务：向量召回的运行配置（主进程解好路径与模型参数再送）。 */
export interface MemoryVectorServiceConfig {
  model: MemoryVectorModel;
  /** GGUF 绝对路径（已就绪的；主进程保证文件存在才送 local 配置） */
  ggufPath: string;
  /** llama-server 二进制绝对路径 */
  binaryPath: string;
  idleUnloadMs: number;
  deferOnBattery: boolean;
}
