/**
 * 审查面板的纯逻辑 —— unified diff → DiffBody 行、来源标签、空态文案。
 * 组件薄、逻辑在这里，`node --test` 直接测（ReviewPanel.tsx 不进测试）。
 */
import { editDiffEntries, parseDiffLines, type EditDiffRow } from "../chat/tool-results.ts";
import { pathParts } from "../chat/path-parts.ts";
import type { Messages } from "../../messages-en.ts";
import type { ReviewDiff, ReviewList, ReviewSource } from "@shared/review";

/**
 * unified diff（git 原样 / 主进程 diff 包产物）→ DiffBody 的条目：
 * meta 行（@@ 头）不进正文——行号列自己会标；del 行带旧行号、add / ctx 带新行号。
 * 相邻的「一删一增」经 editDiffEntries 做词级配对（与聊天内 edit 的展开同一套视觉）。
 */
export function unifiedDiffEntries(diff: string) {
  const { rows } = parseDiffLines(diff);
  const out: EditDiffRow[] = [];
  for (const row of rows) {
    if (row.kind === "meta") continue;
    if (row.kind === "del") {
      out.push({ kind: "del", lineNum: String(row.oldLine ?? ""), text: row.text });
    } else if (row.kind === "add") {
      out.push({ kind: "add", lineNum: String(row.newLine ?? ""), text: row.text });
    } else {
      out.push({ kind: "ctx", lineNum: String(row.newLine ?? row.oldLine ?? ""), text: row.text });
    }
  }
  return editDiffEntries(out);
}

/** 来源的短标签（下拉与空态用）。 */
export function reviewSourceLabel(source: ReviewSource, t: Messages): string {
  return t.review.source(source);
}

/**
 * 空态 / 错误的说明句。no-changes 的标题已经是「还没有改动」，说明句不能再说
 * 一遍——用带来源的 detail（与 entries.length === 0 那条分支同一句）。
 */
export function reviewEmptyText(
  list: Extract<ReviewList, { kind: "empty" | "error" }>,
  t: Messages,
  source: ReviewSource,
): string {
  if (list.kind === "error") return list.message;
  switch (list.reason) {
    case "no-changes":
      return t.review.emptyNoChangesDetail(source);
    case "not-repo":
      return t.review.emptyNotRepo;
    case "no-git":
      return t.review.emptyNoGit;
    case "no-upstream":
      return t.review.emptyNoUpstream;
  }
}

/**
 * 展开一个文件后，正文区不是 diff 时说什么。null = 有 diff 正文，交给 DiffBody。
 * 顺序有讲究：拒绝 / 失败先说（以前它们和「二进制」共用 diff:null，被显示成二进制）；
 * 「改动太大」其次（主进程没读盘没生成，面板换成说明 + 两个出口）；链接再次（面板不读
 * 链接目标）；最后才是已还原 / 二进制。
 */
export type ReviewDiffNotice =
  | { kind: "notice"; text: string; tone: "muted" | "danger" }
  | { kind: "too-large"; exceeded: "bytes" | "lines" };

export function reviewDiffNotice(diff: ReviewDiff, t: Messages): ReviewDiffNotice | null {
  if (diff.error !== undefined) return { kind: "notice", text: t.review.diffError(diff.error.reason), tone: "danger" };
  if (diff.tooLarge !== undefined) return { kind: "too-large", exceeded: diff.tooLarge.exceeded };
  if (diff.symlink !== undefined) return { kind: "notice", text: t.review.symlinkTarget(diff.symlink), tone: "muted" };
  if (diff.diff !== null) return null;
  return { kind: "notice", text: diff.restored ? t.review.restoredEmpty : t.review.binary, tone: "muted" };
}

/** 空态 / 错误的标题（短句）；说明句见 reviewEmptyText。 */
export function reviewEmptyTitle(list: Extract<ReviewList, { kind: "empty" | "error" }>, t: Messages): string {
  if (list.kind === "error") return t.review.errorTitle;
  switch (list.reason) {
    case "no-changes":
      return t.review.emptyNoChanges;
    case "not-repo":
      return t.review.titleNotRepo;
    case "no-git":
      return t.review.titleNoGit;
    case "no-upstream":
      return t.review.titleNoUpstream;
  }
}

/**
 * 审查行的绝对路径（title / 复制 / 「在访达中显示」用）。task 来源的条目本就是
 * 绝对路径（resolveToCwd 的结果）；git 来源是仓库相对路径，按会话 cwd 拼——与
 * 主进程 untrackedEntries 的 `${cwd}/${path}` 同一口径（仓库根 == 会话 cwd 的
 * 常态下两者重合；仓库在 cwd 之上时拼出的路径盘上没有，reveal 会在主进程被
 * realpath 拒绝，如实报错）。
 */
export function absoluteReviewPath(path: string, source: ReviewSource, cwd: string | null): string {
  if (source === "task") return path;
  if (cwd === null || cwd === "") return path;
  return `${cwd}/${path}`;
}

/**
 * 重名文件补显的父目录段（2026-10-18 审查行改版：行里不再铺路径、只显文件名，
 * 同名文件会分不清）。编辑器标签页的做法：一组重名里取「能让整组互相区分」的
 * 最短**尾部**父目录，整组用同一段数——一个补两段、同组另一个只补一段，反而
 * 更难对齐着读。无重名 → null；重名但父目录也全同（同一列表里路径唯一，理论
 * 上不会发生）→ 兜底显示全部目录。
 *
 * 键 = 调用方传入的原路径字符串（列表里唯一，可当行身份用）。
 */
export function disambiguatedDirs(
  paths: readonly string[],
  cwd: string | null,
): ReadonlyMap<string, string | null> {
  const groups = new Map<string, { path: string; dir: string }[]>();
  for (const path of paths) {
    const { name, dir } = pathParts(path, cwd);
    const group = groups.get(name);
    if (group === undefined) groups.set(name, [{ path, dir }]);
    else group.push({ path, dir });
  }
  const out = new Map<string, string | null>();
  for (const group of groups.values()) {
    if (group.length <= 1) {
      out.set(group[0]!.path, null);
      continue;
    }
    const dirs = group.map((item) => (item.dir === "" ? [] : item.dir.split("/")));
    const maxDepth = Math.max(...dirs.map((segs) => segs.length));
    let depth = 1;
    while (depth < maxDepth) {
      const suffixes = new Set(dirs.map((segs) => segs.slice(-depth).join("/")));
      if (suffixes.size === group.length) break;
      depth += 1;
    }
    for (let i = 0; i < group.length; i += 1) {
      out.set(group[i]!.path, dirs[i]!.slice(-depth).join("/"));
    }
  }
  return out;
}
