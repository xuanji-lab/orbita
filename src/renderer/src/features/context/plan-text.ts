/**
 * 计划改动的文案（对话里的「计划改了：…」一行与进度面板共用）：把 PlanChange 按当前语言说成一句话。
 * 纯函数，可被 node --test 直接加载。
 */
import { snippetPair, type GoalLedger } from "../../../../shared/goal-ledger.ts";
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

/** 对话里「目标改了」那一行里一段目标文字最长多少字符 */
const NOTICE_TEXT_MAX = 70;

/**
 * 对话里「目标改了」那一行：这个过程块里的 update_goal 调用（toolCallId）改掉了一个已有的目标才出；
 * 第一次定目标不出（那是开场，不是改动）。一块里改了几次，取最后一次。没有 = null。
 */
export function goalNoticeText(t: Messages, ledger: GoalLedger, toolCallIds: readonly string[]): string | null {
  if (toolCallIds.length === 0) return null;
  const wanted = new Set(toolCallIds);
  for (let i = ledger.entries.length - 1; i >= 0; i--) {
    const entry = ledger.entries[i];
    if (entry?.kind === "goal" && entry.from !== null && wanted.has(entry.id)) {
      // 对话里只占一行：目标很长时两边各缩成不同处附近的一小段（全文在右栏进度最上面）
      const [from, to] = snippetPair(entry.from, entry.to, NOTICE_TEXT_MAX);
      return t.goalText.notice(from, to, entry.why ?? "");
    }
  }
  return null;
}
