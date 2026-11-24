/**
 * 手动压缩的二次确认：菜单里一行说明 + 一个动作键。
 *
 * 两种情形两套话——以前动作键恒为「仍要压缩」，值得压的长对话也被说成「仍要」，
 * 与上面那句普通的「压缩成摘要？」对不上（2026-11-15 实测发现）。
 * - 值得压（自上次压缩以来新增 > 20k）：普通确认 + 「压缩」
 * - 对话还短：提醒省不了多少 + 「仍要压缩」
 */
export interface CompactConfirmText {
  compactConfirm: string;
  compactShort: string;
  compactGo: string;
  compactAnyway: string;
}

export function compactConfirmLabels(worthIt: boolean, text: CompactConfirmText): { hint: string; action: string } {
  return worthIt
    ? { hint: text.compactConfirm, action: text.compactGo }
    : { hint: text.compactShort, action: text.compactAnyway };
}
