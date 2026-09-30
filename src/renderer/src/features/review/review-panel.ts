/**
 * 审查面板的纯逻辑 —— unified diff → DiffBody 行、来源标签、空态文案。
 * 组件薄、逻辑在这里，`node --test` 直接测（ReviewPanel.tsx 不进测试）。
 */
import { editDiffEntries, parseDiffLines, type EditDiffRow } from "../chat/tool-results.ts";
import type { Messages } from "../../messages-en.ts";
import type { ReviewList, ReviewSource } from "@shared/review";

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

/** 空态 / 错误的一句话。 */
export function reviewEmptyText(list: Extract<ReviewList, { kind: "empty" | "error" }>, t: Messages): string {
  if (list.kind === "error") return list.message;
  switch (list.reason) {
    case "no-changes":
      return t.review.emptyNoChanges;
    case "not-repo":
      return t.review.emptyNotRepo;
    case "no-git":
      return t.review.emptyNoGit;
    case "no-upstream":
      return t.review.emptyNoUpstream;
  }
}
