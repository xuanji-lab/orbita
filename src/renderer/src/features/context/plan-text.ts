/**
 * 计划改动的文案（对话里的「计划改了：…」一行与进度面板共用）：把 PlanChange 按当前语言说成一句话。
 * 纯函数，可被 node --test 直接加载。
 */
import type { PlanChange } from "../../../../shared/plan-diff.ts";
import type { Messages } from "../../messages-en.ts";
import type { PlanNotice } from "./plan-timeline.ts";

const quote = (t: Messages, texts: readonly string[]): string => texts.map((text) => t.planText.quoted(text)).join("").trim();

/** 一处改动说成一句（没有句号、不带前缀） */
export function planChangeText(t: Messages, change: PlanChange): string {
  switch (change.kind) {
    case "added":
      return t.planText.added(change.text);
    case "removed":
      return t.planText.removed(change.text);
    case "reworded":
      return t.planText.reworded(change.from, change.to);
    case "moved":
      return t.planText.moved(change.text, change.before ?? "");
    case "split":
      return t.planText.split(change.from, quote(t, change.into));
    case "merged":
      return t.planText.merged(quote(t, change.from), change.into);
  }
}

/** 对话里每个过程块最多一行：改了几处、第一处怎么改、为什么 */
export function planNoticeText(t: Messages, notice: PlanNotice): string {
  const first = notice.changes[0];
  if (first === undefined) return "";
  return t.planText.notice(notice.changes.length, planChangeText(t, first), notice.why ?? "");
}
