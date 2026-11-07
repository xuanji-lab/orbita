/**
 * 全局 Esc（关右栏 / 退文件面板一层 / 关周看板）要不要接这一下。
 *
 * 为什么要看 defaultPrevented：下拉菜单、右键菜单、重命名框、审批条、听写都是在自己的 onKeyDown 里
 * `preventDefault()` 收掉 Esc 的（只关自己），但没有 stopPropagation——事件冒泡到 window 上的全局监听，
 * 菜单关了、紧接着文档标签 / 整个右栏也被关掉（验收：文档面板打开「纸面」下拉按 Esc，当前文档标签一起没了）。
 * 谁已经认领了这一下，全局就不再接；输入法组词中的 Esc 是取消组词，同理不接。
 */
export function isUnclaimedEscape(event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing">): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !event.isComposing;
}
