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
 */

export type ReviewSource = "task" | "unstaged" | "staged" | "branch";

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
  /** task 来源专用：基线与磁盘现状已一致（回退 / 撤销之后），列表标「已还原」 */
  restored?: boolean;
  /** task 来源专用：快照不可用（超限 / 非 utf8 / blob 丢失），出不了基线 diff */
  noBaseline?: boolean;
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
}
