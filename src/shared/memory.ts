/**
 * 会话记忆（memory）的契约真源：条目形状、召回载荷、注入记录与管理面 IPC。
 *
 * 设计取向（三个参考系统的调研结论，详见各 commit message）：
 * - **入库前蒸馏**：条目是自包含、第三人称、时间绝对的陈述句（atommem 的原子事实
 *   ≡ mandol 的 God Mode 改写，两家实测共同指向的最大杠杆），不是原始对话片段。
 * - **词法召回**：语料小、条目本身是高信号蒸馏句，关键词+正文重叠打分够用；
 *   向量检索刻意缓办（打分器在 `src/main/memory/retrieve.ts`，留扩展位）。
 * - **按作用域隔离**：scopeId 由主进程按会话归属解析（workspaceId ?? cwd），
 *   agent 进程不碰 userData（readTaskRequest 同一条边界）。
 *
 * v2 扩展（记忆管理面 + 摘抄）：条目带上来源 / 状态 / 常驻 / 态度 / 出处 / 冲突
 * 建议，全部**可选**——旧 JSONL 缺字段按 distilled + active 解读，不迁移旧文件。
 */

/** 一条蒸馏后的记忆条目。 */
export interface MemoryEntry {
  /** `mem_` 前缀的 uuid（主进程落盘时分配，蒸馏侧不造 id） */
  id: string;
  /** 自包含、第三人称、时间绝对的陈述句；摘抄则存逐字原文 */
  text: string;
  /** 蒸馏时模型给的提取词（≤8 个），全文检索的主信号。摘抄为空（常驻，不走打分） */
  keywords: string[];
  /** 来源会话 id（溯源用） */
  sessionId: string;
  /** 来源轮的用户消息时间（epoch ms） */
  timestamp: number;
  // ── v2 扩展字段：全部可选，缺席的语义写在各自注释里 ──
  /** 来源：自动蒸馏（缺席 = distilled）/ 摘抄 / 手动添加 */
  source?: MemorySource;
  /** 状态：缺席 = active。superseded = 被新条目替代（召回跳过）；muted = 不再注入 */
  status?: MemoryStatus;
  /** 常驻（每轮召回总是注入，不走词法打分）。摘抄默认常驻 */
  pinned?: boolean;
  /** 摘抄的态度：自己的话是立场，agent 的话按认同 / 存疑 / 反对 */
  stance?: MemoryStance;
  /** 摘抄的出处（逐字原文与轮号）。手动添加的条目没有 */
  origin?: MemoryEntryOrigin;
  /** 来源轮号（按用户消息计，1 起）。旧条目没有；按轮分组的键 */
  turn?: number;
  /** 上次编辑时间（epoch ms）。缺席 = 没编辑过 */
  editedAt?: number;
  /** 冲突建议：这条（新）可能推翻的旧条目 id。只作建议，用户拍板前不动旧条目 */
  supersedes?: string;
  /** 冲突建议的处理结果。缺席 + supersedes 有值 = 待处理 */
  conflictResolution?: MemoryConflictResolution;
  /** 被哪条新条目替代（status = superseded 时指向它），撤销替代时用它找回 */
  supersededBy?: string;
}

/** 条目来源。manual：设置 › 记忆库「手动添加」的（算用户的话，常驻）。 */
export type MemorySource = "distilled" | "excerpt" | "manual";

/** 条目状态。召回只认 active。 */
export type MemoryStatus = "active" | "superseded" | "muted";

/** 摘抄态度：position = 我说的·立场；其余三个只用于 agent 的话。 */
export type MemoryStance = "position" | "agree" | "doubt" | "oppose";

/** 摘抄的逐字原文与出处（text 被编辑后原文仍在）。 */
export interface MemoryEntryOrigin {
  /** 划选时的逐字原文（已规整空白） */
  verbatim: string;
  /** 第几轮（按用户消息计，1 起） */
  turn: number;
  /** 谁说的 */
  role: "user" | "assistant";
}

/** 冲突卡的处理结果（用户拍板）。 */
export type MemoryConflictResolution = "replace" | "keep-both" | "drop-new";

/**
 * 全局作用域 id：跨工作区共享的记忆。「移到全局」把条目搬进这里；召回时与当前
 * 作用域合并注入。用保留字而不是裸字符串字面量，调用点有唯一真源。
 * 不会与真实 scopeId 相撞：workspaceId 是 uuid、cwd 是绝对路径。
 */
export const MEMORY_GLOBAL_SCOPE = "__orbita_memory_global__";

/**
 * 作用域的盘上 token：scopeId 的 sha1 hex——**记忆库管理面的地址就是它**。
 * scopeId → token 单向（文件名本来就是哈希），管理面（列表 / 删除 / 移动）按 token
 * 寻址，scopeId 只活在 agent 侧（召回 / 落盘，由主进程按会话归属解析）。
 */
export type MemoryScopeToken = string;

/** 召回命中：条目 + 归一化分（0..1，越高越相关）。pinned = 常驻注入（不打分）。 */
export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
  pinned?: boolean;
}

/**
 * memoryRetrieveRequest 的回执载荷（readTaskResult 同款的 ok 双分支）。
 * 空库 / 无命中也是 ok: true 配空 hits——「没东西可注入」不是错误。
 */
export type MemoryRetrieveOutcome = { ok: true; hits: MemoryHit[] } | { ok: false; error: string };

/**
 * 一轮的注入记录（`memory/injections.jsonl` 一行一条，只追加）。
 * **每轮都落一条（包括零命中）**——它是审查面板「按轮」的地基：哪轮注入了什么、
 * 用过几次、最近一次，全从这份账推导；零命中的轮也要能说出「这轮没有注入」。
 */
export interface MemoryInjectionRecord {
  sessionId: string;
  /** 第几轮（按用户消息计，1 起） */
  turn: number;
  /** 开轮时刻（epoch ms） */
  at: number;
  /** 注入的条目与分数（常驻摘抄在内，score = 1）；空数组 = 这轮没注入 */
  hits: readonly { id: string; score: number }[];
}

/**
 * 蒸馏侧产出、待落盘的条目（还没有 id / sessionId，那两个由主进程落盘时补）。
 * 与 MemoryEntry 分开：id 的分配权在落盘侧，蒸馏侧不该能伪造来源。
 */
export interface MemoryDraft {
  text: string;
  keywords: string[];
  /** 来源轮的用户消息时间（epoch ms） */
  timestamp: number;
  /** 冲突建议：蒸馏模型判定这条可能推翻的旧条目 id（须在给它的候选里）。缺席 = 无 */
  supersedes?: string;
}

/* ---------- 记忆管理面（设置 › 记忆库，renderer↔main IPC） ---------- */

/** 作用域清单的一项：管理面的地址是 token（见 MemoryScopeToken）。 */
export interface MemoryScopeInfo {
  token: MemoryScopeToken;
  kind: "workspace" | "home" | "global";
  /** 显示名：工作区名 / Home / 全局（跨工作区） */
  name: string;
  /** 条目数 */
  count: number;
}

export type MemoryScopesResponse = { scopes: MemoryScopeInfo[] };

/** 条目的使用统计（从注入记录推导，不落在条目上）。 */
export interface MemoryUsage {
  /** 被注入过几次（含常驻） */
  count: number;
  /** 最近一次注入时刻；null = 从没用过 */
  lastAt: number | null;
}

/** 记忆库的一行：条目 + 使用统计 + 出处会话的标题（跳回原会话用）。 */
export interface MemoryLibraryItem {
  entry: MemoryEntry;
  usage: MemoryUsage;
  /** 来源会话标题；null = 会话已删 / meta 读不到 */
  sessionTitle: string | null;
}

export type MemoryEntriesRequest = { token: MemoryScopeToken };
export type MemoryEntriesResponse = { items: MemoryLibraryItem[] };

/** 编辑条目（原地改写该作用域文件）。缺席的字段不动。 */
export interface MemoryPatchRequest {
  token: MemoryScopeToken;
  entryId: string;
  /** 编辑正文（trim 后非空才生效） */
  text?: string;
  /** 摘抄常驻开关 */
  pinned?: boolean;
  /** 状态（muted = 不再注入；active = 解除） */
  status?: MemoryStatus;
  /** 改态度（摘抄的三选 / 立场） */
  stance?: MemoryStance;
}
export type MemoryPatchResponse = { entry: MemoryEntry | null };

export interface MemoryRemoveBatchRequest {
  token: MemoryScopeToken;
  entryIds: string[];
}
export type MemoryRemoveBatchResponse = { removed: number };

/** 移到全局（跨工作区召回）。从 token 指的作用域搬进全局作用域文件。 */
export interface MemoryMoveGlobalRequest {
  token: MemoryScopeToken;
  entryIds: string[];
}
export type MemoryMoveGlobalResponse = { moved: number };

/**
 * 冲突拍板（或撤销拍板）。resolution 是**当初的**处理结果；undo = true 把它翻回去
 * （drop-new 的撤销不支持——新条目已删，无处翻回，UI 不给撤销键）。
 */
export interface MemoryResolveRequest {
  token: MemoryScopeToken;
  /** 新条目（带冲突建议的那条） */
  newId: string;
  /** 被建议推翻的旧条目 */
  oldId: string;
  resolution: MemoryConflictResolution;
  undo?: boolean;
}
export type MemoryResolveResponse = { resolved: boolean };

/** 添加摘抄（聊天划选）：作用域由主进程按会话归属解析，不由 renderer 给。 */
export interface MemoryExcerptRequest {
  sessionId: string;
  /** 逐字原文（已规整空白） */
  verbatim: string;
  role: "user" | "assistant";
  /** 第几轮（1 起） */
  turn: number;
  /** 态度：自己的话 = position；agent 的话 = agree / doubt / oppose */
  stance: MemoryStance;
}
export type MemoryExcerptResponse = { entry: MemoryEntry | null };

/** 手动添加（设置 › 记忆库）：用户自己写的一条，常驻、算「我说的 · 立场」。 */
export interface MemoryAddManualRequest {
  token: MemoryScopeToken;
  text: string;
}
export type MemoryAddManualResponse = { entry: MemoryEntry | null };

/** 审查面板记忆页签的一轮汇总。 */
export interface MemoryTurnAdded {
  entry: MemoryEntry;
  /** 待处理的冲突建议：被这条可能推翻的旧条目（找不到 = null，已删 / 已处理） */
  conflictWith: MemoryEntry | null;
}

/** 一轮开始前注入的条目（正文冗余进响应：面板要直接展示，不再回查条目）。 */
export interface MemoryTurnInjected {
  id: string;
  text: string;
  timestamp: number;
  /** 相关度（0..1）；常驻摘抄 = 1 */
  score: number;
  pinned: boolean;
  /** 所在作用域（「以后不再注入」等改动要带 token 回去寻址） */
  token: MemoryScopeToken;
}

export interface MemoryTurnSummary {
  turn: number;
  /** 开轮时刻（epoch ms） */
  at: number;
  /** 本轮蒸馏 / 摘抄新增的条目（倒序列表里的一行）；空 = 没蒸出东西 */
  added: readonly MemoryTurnAdded[];
  /** 轮前注入的条目；空 = 没注入 */
  injected: readonly MemoryTurnInjected[];
}

export interface MemorySessionTurnsResponse {
  /** 新在前 */
  turns: readonly MemoryTurnSummary[];
  /** 该作用域（含全局）待处理冲突数——记忆页签的徽标 */
  pendingConflicts: number;
  /** 本会话作用域的 token：面板上的改动（撤一条 / 不再注入 / 拍板）按它寻址 */
  scopeToken: string;
}

/** 右栏 › 摘抄页签的一行：所有作用域里的 excerpt 条目（含全局），跨会话跳转用。 */
export interface MemoryExcerptItem {
  entry: MemoryEntry;
  /** 所在作用域（patch / 删除要带回来寻址） */
  token: MemoryScopeToken;
  /** 出处会话标题；null = 会话已删（不可跳转，也不可按标题搜索） */
  sessionTitle: string | null;
  /** 是不是当前正在看的这条会话摘的 */
  current: boolean;
}

export type MemoryExcerptsRequest = { sessionId: string };
export type MemoryExcerptsResponse = { items: MemoryExcerptItem[] };
