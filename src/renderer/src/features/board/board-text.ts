/** 看板界面的文案拼装（纯函数，可测）。 */
import type { BoardSkippedCard } from "../../../../shared/plugin-board.ts";
import type { Messages } from "../../messages-en.ts";

type T = Messages["board"];

/** 被跳过的卡：「没有显示：today: 数据太大; items: 模板读不出来」；没有被跳过的回 null。 */
export function skippedText(t: T, skipped: readonly BoardSkippedCard[]): string | null {
  if (skipped.length === 0) return null;
  return t.skipped(skipped.map((card) => `${card.id}: ${t.skipReason[card.reason]}`).join("; "));
}
