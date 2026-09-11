/**
 * 撤回的文字怎么接回草稿 —— 纯函数，useChatSession 的可测内核。
 *
 * 排队卡的撤回把条目从队列里拿回输入框（见 docs/plans/2026-09-06-排队卡动作收敛.md）。
 * 连点几条就是依次堆叠——合成一条还是拆开发，交给用户在输入框里自己决定，
 * 这里只负责不丢字、不留空行。
 */

/**
 * 接在现有草稿后面，换行分隔；草稿是空白就直接用撤回的文字。
 *
 * 尾部空白先削掉再接：用户草稿常以换行结尾，不削就会多出一个空行。
 */
export function appendWithdrawn(draft: string, text: string): string {
  if (text === "") return draft;
  if (draft.trim() === "") return text;
  return `${draft.replace(/\s+$/, "")}\n${text}`;
}
