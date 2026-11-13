/**
 * 审查面板契约 —— IPC 四层的第 1 层。
 *
 * 面板回答「这一刻磁盘上的改动是什么样」。四种来源：
 *   task      本任务改动（默认）：基线 = 本任务首次改该文件前的快照（含已撤回轮次），
 *             对比 = 磁盘现状。不依赖 git——没有仓库的目录一样能用
 *   unstaged  git 工作区未暂存改动
 *   staged    git 已暂存改动
 *   branch    git 分支对比（upstream...HEAD，领先 + 落后的合计）
 *
 * git 三个来源**只读**（status / diff / rev-parse，绝不写）；列表与统计在主进程算好，
 * renderer 不碰 git。diff 正文按需拉（`review:diff`）——一屏只展开一个文件。
 *
 * **读盘边界**：`review:diff` 的 path 是 renderer 传来的，主进程不信——git 来源只认工作区相对、
 * resolve / realpath 后仍在工作区里的路径；task 来源只认本任务文件账上的路径。符号链接（git 未跟踪 /
 * task 来源）不跟到目标读，只报「这是个链接、指向哪」。拒绝与失败走 `ReviewDiff.error`，
 * 不再伪装成「二进制」。
 */

export type ReviewSource = "task" | "unstaged" | "staged" | "branch";

/**
 * 正文（diff）的生成上限，用户 2026-10-28 拍板：**超过 5000 行或 1 MB 就不生成正文**，
 * 面板显示「改动太大」并给出外部打开的出口——不读盘、不造 patch、不截断首尾
 * （截断会切断 hunk、丢行号）。判的是**diff 本身**（增删行数 / diff 字节数），
 * 不是文件大小：1 MB 的文件只改了几行，diff 很小，照常展开。
 */
export const REVIEW_DIFF_MAX_LINES = 5000;

export const REVIEW_DIFF_MAX_BYTES = 1024 * 1024;

/** 一段 diff 超没超上限：超了返回是哪个维度超的，没超返回 null（主进程两处来源共用） */
const utf8 = new TextEncoder();

export function reviewDiffOverflow(diff: string): "bytes" | "lines" | null {
  if (utf8.encode(diff).length > REVIEW_DIFF_MAX_BYTES) return "bytes";
  let changed = 0;
  for (const line of diff.split("\n")) {
    // +++ / --- 是文件头，不算增删行（与数 patch 里 +/- 行的口径一致）
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      changed += 1;
      if (changed > REVIEW_DIFF_MAX_LINES) return "lines";
    }
  }
  return null;
}

export const REVIEW_SOURCES: readonly ReviewSource[] = ["task", "unstaged", "staged", "branch"];

export function isReviewSource(raw: unknown): raw is ReviewSource {
  return (REVIEW_SOURCES as readonly unknown[]).includes(raw);
}

/** 列表里的一个文件。added / removed 是行级统计（git numstat 同口径）。 */
export interface ReviewEntry {
  /** git 来源 = 仓库相对路径；task 来源 = 绝对路径（resolveToCwd 的结果） */
  path: string;
  added: number;
  removed: number;
  /** 二进制（git numstat 的 `-`）：没有行级统计，也不出 diff 正文 */
  binary: boolean;
  /**
   * 未跟踪文件没有数行（与专注左栏 FocusChangeEntry.lineCountUnknown 同一个计数器）：超过单文件计数上限，
   * 或这一轮的读盘预算用完、留到下一轮；task 来源的文件超过正文上限（REVIEW_DIFF_MAX_*）时
   * 数增删行要整读整比，同样跳过、标这一位。added 是 0 但**不是**「没改动」，UI 显示「行数未知」。
   * 它不等于「文件太大」：要判大小看字节数，预算用完的也可能是个小文件。
   */
  lineCountUnknown?: boolean;
  /** task 来源专用：基线与磁盘现状已一致（回退 / 撤销之后），列表标「已还原」 */
  restored?: boolean;
  /** task 来源专用：快照不可用（超限 / 非 utf8 / blob 丢失），出不了基线 diff */
  noBaseline?: boolean;
  /**
   * 这一项是符号链接（git 未跟踪 / task 来源）：面板不跟到目标去读，added / removed 恒为 0。
   * 值是链接里写的目标（readlink 原文，可能是相对路径），界面标「链接」并给出它指向哪
   */
  symlink?: string;
}

/**
 * `review:list` 的回执。空态与错误分开说——「没有改动」和「出不了结果」
 * 在界面上是两种话（设计系统：refusals explain the blocker）。
 */
export type ReviewList =
  | {
      kind: "ok";
      cwd: string;
      entries: ReviewEntry[];
      /** branch 来源：upstream 的短名（origin/main），头部说明行用 */
      upstream?: string;
    }
  | { kind: "empty"; reason: ReviewEmptyReason; cwd: string }
  | { kind: "error"; message: string; cwd: string };

export type ReviewEmptyReason =
  /** 没有任何改动（列表为空是正常态，不是错误） */
  | "no-changes"
  /** 这个目录不是 git 仓库（task 来源不受影响，git 三源显式说明） */
  | "not-repo"
  /** 机器上没有 git（ENOENT） */
  | "no-git"
  /** 当前分支没有 upstream，分支对比出不了 */
  | "no-upstream";

/**
 * `review:diff` 的回执。diff 是 **unified diff**（git 原样 / 主进程用 diff 包生成），
 * renderer 统一走 parseDiffLines 那条解析路（与 ChatView 的 pi 展示格式共用 DiffBody）。
 */
export interface ReviewDiff {
  diff: string | null;
  /** 二进制文件不出正文 */
  binary: boolean;
  /** task 来源：基线与现状一致，没有正文可展开 */
  restored: boolean;
  /** 同 ReviewEntry.symlink：链接本身，正文不读（diff 恒 null） */
  symlink?: string;
  /**
   * 改动超过正文上限（REVIEW_DIFF_MAX_*）：主进程**没有读盘 / 没有生成 patch**，
   * diff 恒 null。面板显示「改动太大」，给「用默认应用打开 / 在文件面板看」两个出口。
   * exceeded 说的是哪个维度超了；message 是英文原句（日志 / 悬停用）。
   */
  tooLarge?: { exceeded: "bytes" | "lines"; message: string };
  /**
   * 拒绝或失败：diff 恒 null、binary / restored 恒 false，面板按 reason 说清楚。以前这些情况
   * 一律回 `{ diff: null, binary: false }`，界面显示成「二进制」。message 是英文原句（日志 / 悬停用）
   */
  error?: { reason: ReviewDiffErrorReason; message: string };
}

export type ReviewDiffErrorReason =
  /** 入参形状不对（renderer 侧 bug） */
  | "invalid-request"
  /** 会话不在了（meta 读不到） */
  | "task-not-found"
  /** git 来源：绝对路径，或 resolve / realpath 之后不在工作区（会话 cwd）里 */
  | "outside-workspace"
  /** task 来源：路径不在本任务的文件账上 */
  | "not-in-record"
  /** 跑 git / 读盘抛错 */
  | "failed";

/** 拒绝 / 失败的回执（主进程三处共用：ipc 入口、git 来源、task 来源） */
export function reviewDiffError(reason: ReviewDiffErrorReason, message: string): ReviewDiff {
  return { diff: null, binary: false, restored: false, error: { reason, message } };
}

/** 「改动太大」的回执（git / task 来源在判定处共用；上限见 REVIEW_DIFF_MAX_* 注释） */
export function reviewDiffTooLarge(exceeded: "bytes" | "lines", message: string): ReviewDiff {
  return { diff: null, binary: false, restored: false, tooLarge: { exceeded, message } };
}

// ————————————————————————————————————————————————
// git 只读输出的纯解析（主进程调用，这里单测）
// ————————————————————————————————————————————

/**
 * `git diff --numstat` 的一行 → 文件条目。`added / removed` 为 `-` 是二进制。
 * 调用方（git-source）已带 `--no-renames`，numstat 不产 `old => new` 改名形态；
 * 万一出现，按字面路径解析（读不了盘 / 拉不到 diff 就空正文，不猜）。
 * 解不了返回 null（空行 / 格式漂移），调用方跳过。
 */
export function parseNumstatLine(line: string): ReviewEntry | null {
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const added = parts[0];
  const removed = parts[1];
  const path = parts.slice(2).join("\t");
  if (path === "" || added === undefined || removed === undefined) return null;
  const binary = added === "-" || removed === "-";
  if (binary) return { path, added: 0, removed: 0, binary: true };
  const addedNum = Number(added);
  const removedNum = Number(removed);
  if (!Number.isFinite(addedNum) || !Number.isFinite(removedNum)) return null;
  return { path, added: addedNum, removed: removedNum, binary: false };
}

/** `git status --porcelain=v2` 的未跟踪行（`? path`，含尾随引号形态）→ path。 */
export function parseUntrackedLine(line: string): string | null {
  if (!line.startsWith("? ")) return null;
  let path = line.slice(2);
  // 调用方（realGitRunner）已带 core.quotepath=false，非 ASCII 路径原样输出，不再被 C 引用；
  // 但含 `"` / `\\` / 控制字符的路径 git 始终会 C 引用——剥引号不解转义（这种路径极端罕见，展示用够）
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) path = path.slice(1, -1);
  return path === "" ? null : path;
}

/**
 * `git status --porcelain=v2` 的已跟踪改动行（`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`）
 * → path 与 XY（暂存位 + 工作区位，`.` = 那一侧没动）。专注模式的左栏文件树用它分 U / M：
 * 有一侧是 A（新增）就算新文件（U），其余（M / D / T / R / C）算修改（M）。
 * 改名行（`2`）不产——调用方带 `--no-renames`；万一出现返回 null 跳过，不猜。
 * 解不了（空行、格式漂移、路径为空）返回 null。
 */
export function parseStatusChangedLine(line: string): { path: string; xy: string } | null {
  if (!line.startsWith("1 ")) return null;
  const parts = line.split(" ");
  // parts[0]="1"，[1]=XY，[2..7]=sub/mH/mI/mW/hH/hI，[8..]=path（可含空格，原样拼回）
  if (parts.length < 9) return null;
  const xy = parts[1] ?? "";
  const path = parts.slice(8).join(" ");
  if (xy.length !== 2 || path === "") return null;
  return { path, xy };
}
