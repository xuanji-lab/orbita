/**
 * 会话回退 / 单轮撤销的契约 —— IPC 四层的第 1 层（与审查面板的 `review.ts` 并列）。
 *
 * 三个新 transcript 记录角色（与 CompactedRecord / ChannelMarkRecord 同一条纪律：
 * 单独一个 role，逐字段校验，坏行跳过）：
 *
 *   file-turn  轮尾文件账：一轮 agent 落定后改过哪些文件、每个文件改前 / 改后的快照引用
 *   revert     回退界碑：readLog 在这里折叠生效列表（截到 targetMessageId 之前）
 *   undo       单轮撤销：不动对话，只标记「这一轮的文件改动已被撤销」
 *
 * 快照正文（before / after）按内容寻址存在 `sessions/<id>.snapshots/<sha1>.txt`，
 * 落在 sessions/ 里 = 天然受 protectedPaths 保护、随会话一起删。transcript 记录里
 * 只存引用（blob 文件名），JSONL 不背正文。
 *
 * agent 进程 → 主进程的 `fileTurn` 事件携带**内联正文**（FileChangePayload），
 * 主进程写成 blob 后落 FileTurnRecord（FileChange，引用式）——两个类型都是契约，
 * 别混用：一个走 utility 进程端口，一个走盘。
 */

/** 快照正文的字节数上限：超过就不存正文、标「无法回退」。1MB。 */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** 盘上的一条快照引用（FileChange 里 before / after 的形状）。 */
export type SnapshotRef =
  /** 可还原的文本快照；blob 是 snapshots/ 下的文件名 */
  | { kind: "text"; blob: string }
  /** 快照时刻文件不存在（还原 = 删除该文件） */
  | { kind: "absent" }
  /** 超过 SNAPSHOT_MAX_BYTES 或非 utf8：不存正文，无法回退 */
  | { kind: "unrecoverable" };

/** 落盘的轮内文件改动（FileTurnRecord.changes 的一项）。 */
export interface FileChange {
  /** resolveToCwd 之后的绝对路径（与 pi 的 write / edit 同一套解析） */
  path: string;
  /** 该轮内此路径**最早**的改前快照（还原目标） */
  before: SnapshotRef;
  /** 该轮内此路径**最后**的改后快照（识别用户手改的比较基准） */
  after: SnapshotRef;
  /** 行级统计（after vs before，unified diff 的 + / − 行数） */
  added: number;
  removed: number;
}

/**
 * 轮尾账的**渲染视图**（主进程 → renderer 广播用）：不带快照——卡片只要路径与
 * 统计，正文（可能 1MB）没有理由过 IPC 进 renderer。盘上读回的 FileTurnRecord
 * 结构上是它的超集，种子时直接兼容。
 */
export interface FileChangeView {
  path: string;
  added: number;
  removed: number;
}

export interface FileTurnView {
  role: "file-turn";
  id: string;
  timestamp: number;
  changes: readonly FileChangeView[];
  /**
   * 旁路网页产物（脚本生成）的绝对路径，与 changes 同一张卡的另一栏：不在文件账里
   * （write / edit 之外的手段产出）、不参与撤销，卡片上只能打开。缺席 = 本轮没有。
   */
  webArtifacts?: readonly string[];
  /**
   * 批量折叠：本轮网页文件变动超过上限时不逐个列（webArtifacts 缺席），只报计数。
   * 卡片出一行「本轮有 N 个网页文件变动（像是批量操作，未逐个列出）」，不带打开
   * 按钮。缺席 = 没折叠过（旧记录没有这个字段，照常解析）。
   */
  webArtifactsBatch?: number;
}

/** agent 进程报上来的轮内改动：正文内联，主进程负责写 blob。 */
export type SnapshotPayload =
  | { kind: "text"; content: string }
  | { kind: "absent" }
  | { kind: "unrecoverable" };

export interface FileChangePayload {
  path: string;
  before: SnapshotPayload;
  after: SnapshotPayload;
  added: number;
  removed: number;
}

/** 轮尾文件账（role: "file-turn"）。changes 为空的事件不落记录（没有改动的轮不产卡）。 */
export interface FileTurnRecord {
  role: "file-turn";
  id: string;
  timestamp: number;
  changes: readonly FileChange[];
  /**
   * 旁路网页产物：本轮经脚本（bash 等）生成 / 改动、文件账看不见的 .html / .htm / .svg
   * 绝对路径（轮尾扫描按 mtime ≥ 开轮时刻收出来、扣掉已在 changes 里的）。
   * **不参与撤销**——没拍内容快照，撤不回去；卡片上标「脚本生成 · 仅可打开」。
   * 缺席 = 本轮没有（旧记录没有这个字段，照常解析）。只有旁路产物、没有 changes
   * 的轮也落记录、也出卡。
   */
  webArtifacts?: readonly string[];
  /**
   * 批量折叠计数：本轮网页文件变动超过上限（批量操作嫌疑），不逐个列、只报计数。
   * 与 webArtifacts 互斥（折叠时不给列表）。缺席 = 没折叠过；只有它、没有 changes
   * 的轮也落记录（卡片要出那一行计数）。
   */
  webArtifactsBatch?: number;
}

/** 回退记录（role: "revert"）。readLog 按它折叠生效列表。 */
export interface RevertRecord {
  role: "revert";
  id: string;
  /** 回退到哪条 user 消息之前：该消息及之后全部被撤出生效列表 */
  targetMessageId: string;
  /** 执行结果按路径落账（skipped = 快照不可用 / 写盘失败） */
  restored: readonly RevertFileOutcome[];
  timestamp: number;
}

export interface RevertFileOutcome {
  path: string;
  outcome: "restored" | "deleted" | "skipped";
  /**
   * skipped 的原因（写盘失败的错误码 / 快照不可用）。**必须回传给用户看**：
   * 「撤销完成」而文件其实没回去，是这个字段存在之前的静默失败（实机：文件被
   * 占用 → EBUSY → 只有主进程日志知道）。旧记录没有这个字段，照常解析。
   */
  reason?: string;
}

/** 单轮撤销记录（role: "undo"）。不动对话，轮尾卡片据此挂「已撤销」。 */
export interface UndoRecord {
  role: "undo";
  id: string;
  /** 被撤销的轮尾账（FileTurnRecord）id */
  turnId: string;
  restored: readonly RevertFileOutcome[];
  timestamp: number;
}

/** SnapshotRef 的逐字段校验（readLog / 载荷解析共用）。 */
export function isSnapshotRef(raw: unknown): raw is SnapshotRef {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  if (value["kind"] === "absent" || value["kind"] === "unrecoverable") return true;
  return value["kind"] === "text" && typeof value["blob"] === "string" && value["blob"] !== "";
}

function parseWebArtifacts(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item === "") return undefined;
    paths.push(item);
  }
  return paths;
}

/** webArtifactsBatch 的逐字段校验：可选；在场必须是 ≥ 1 的整数（折叠计数不会是 0）。 */
function parseWebArtifactsBatch(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return undefined;
  return raw;
}

function parseFileChange(raw: unknown): FileChange | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value["path"] !== "string" || value["path"] === "") return null;
  if (!isSnapshotRef(value["before"]) || !isSnapshotRef(value["after"])) return null;
  if (typeof value["added"] !== "number" || typeof value["removed"] !== "number") return null;
  return {
    path: value["path"],
    before: value["before"],
    after: value["after"],
    added: value["added"],
    removed: value["removed"],
  };
}

export function isFileTurnRecord(raw: unknown): raw is FileTurnRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  if (value["role"] !== "file-turn" || typeof value["id"] !== "string") return false;
  if (typeof value["timestamp"] !== "number") return false;
  if (!Array.isArray(value["changes"])) return false;
  if (!value["changes"].every((change) => parseFileChange(change) !== null)) return false;
  // webArtifacts 可选（旧记录没有）；**在场就必须是合法路径数组**——旁路行挂在卡上、
  // 还要过主进程的打开白名单，半个坏值整条拒掉（同「逐字段校验，坏行跳过」的纪律）。
  // webArtifactsBatch 同一张纪律：在场就必须是 ≥ 1 的整数。
  if ("webArtifacts" in value && parseWebArtifacts(value["webArtifacts"]) === undefined) return false;
  if ("webArtifactsBatch" in value && parseWebArtifactsBatch(value["webArtifactsBatch"]) === undefined) {
    return false;
  }
  return true;
}

function parseOutcome(raw: unknown): RevertFileOutcome | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value["path"] !== "string" || value["path"] === "") return null;
  if (value["outcome"] !== "restored" && value["outcome"] !== "deleted" && value["outcome"] !== "skipped") {
    return null;
  }
  // reason 可选（旧记录没有）；在场就必须是非空字符串——半个坏值整条拒掉
  if ("reason" in value && (typeof value["reason"] !== "string" || value["reason"] === "")) return null;
  return typeof value["reason"] === "string"
    ? { path: value["path"], outcome: value["outcome"], reason: value["reason"] }
    : { path: value["path"], outcome: value["outcome"] };
}

function parseOutcomes(raw: unknown): readonly RevertFileOutcome[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed: RevertFileOutcome[] = [];
  for (const item of raw) {
    const outcome = parseOutcome(item);
    if (outcome === null) return null;
    parsed.push(outcome);
  }
  return parsed;
}

export function isRevertRecord(raw: unknown): raw is RevertRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return (
    value["role"] === "revert" &&
    typeof value["id"] === "string" &&
    typeof value["targetMessageId"] === "string" &&
    parseOutcomes(value["restored"]) !== null &&
    typeof value["timestamp"] === "number"
  );
}

export function isUndoRecord(raw: unknown): raw is UndoRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return (
    value["role"] === "undo" &&
    typeof value["id"] === "string" &&
    typeof value["turnId"] === "string" &&
    parseOutcomes(value["restored"]) !== null &&
    typeof value["timestamp"] === "number"
  );
}

/** SnapshotPayload 的逐字段校验（fileTurn 事件载荷解析用，防御端口对面的坏值）。 */
export function parseFileChangePayload(raw: unknown): FileChangePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value["path"] !== "string" || value["path"] === "") return null;
  const snapshot = (raw2: unknown): SnapshotPayload | null => {
    if (typeof raw2 !== "object" || raw2 === null) return null;
    const item = raw2 as Record<string, unknown>;
    if (item["kind"] === "absent" || item["kind"] === "unrecoverable") return { kind: item["kind"] };
    if (item["kind"] === "text" && typeof item["content"] === "string") return { kind: "text", content: item["content"] };
    return null;
  };
  const before = snapshot(value["before"]);
  const after = snapshot(value["after"]);
  if (before === null || after === null) return null;
  if (typeof value["added"] !== "number" || typeof value["removed"] !== "number") return null;
  return { path: value["path"], before, after, added: value["added"], removed: value["removed"] };
}

// ————————————————————————————————————————————————
// 纯判定：回退 / 撤销要还原哪些文件
// ————————————————————————————————————————————

/**
 * 一段轮次范围里，每个路径「还原到什么」：
 * - 取该路径在范围内**最早**的 before（回退语义：还原到被撤的第一轮动手之前）；
 * - before 为 absent → 该文件是被撤轮次新建的，还原 = 删除；
 * - before 为 unrecoverable → 无法回退。
 */
export interface RestorePlanEntry {
  path: string;
  before: SnapshotRef;
}

export function planRestores(turns: readonly FileTurnRecord[]): Map<string, SnapshotRef> {
  const byPath = new Map<string, SnapshotRef>();
  for (const turn of turns) {
    for (const change of turn.changes) {
      if (!byPath.has(change.path)) byPath.set(change.path, change.before);
    }
  }
  return byPath;
}

/** 一段轮次范围里每个路径**最后**的 after（识别用户手改的比较基准）。 */
export function latestAfters(turns: readonly FileTurnRecord[]): Map<string, SnapshotRef> {
  const byPath = new Map<string, SnapshotRef>();
  for (const turn of turns) {
    for (const change of turn.changes) {
      byPath.set(change.path, change.after);
    }
  }
  return byPath;
}

// ————————————————————————————————————————————————
// 确认框要展示的计划（回执形状）
// ————————————————————————————————————————————

/** `session:revert-plan` 的回执：确认框照它列清单，不自己再读一遍盘。 */
export interface RevertPlan {
  /** 将恢复的文件（改回快照内容） */
  restore: readonly string[];
  /** 将删除的文件（被撤轮次新建、回退前不存在） */
  deletes: readonly string[];
  /**
   * 警示组：磁盘当前内容 ≠ 快照记录的 agent 改完内容的文件——
 * 用户手改过（或 shell 改过），回退会把这部分修改一并撤回。
   */
  userModified: readonly string[];
  /** 快照不可用（超限 / 非 utf8 / blob 丢失），回退不会动这些文件 */
  unrecoverable: readonly string[];
}

/** `session:undo-plan` 的回执。 */
export interface UndoPlan {
  turnId: string;
  restore: readonly string[];
  deletes: readonly string[];
  /** 磁盘 ≠ 该轮 after（用户手改过，撤销会一并撤回） */
  userModified: readonly string[];
  /** 该轮之后（未回退的）轮次也改过的同一文件——撤销会连它们的改动一起退掉 */
  laterTouched: readonly string[];
  unrecoverable: readonly string[];
}
