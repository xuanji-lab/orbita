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

/**
 * 打开着的菜单要不要在**文档级**接管 Esc。
 *
 * 菜单自己的 onKeyDown 只在焦点落在菜单里时才收得到 Esc；而下拉菜单的触发键常常还留着焦点
 * （文档面板的「纸面」下拉实测：点开后 activeElement 仍是触发键），这时 Esc 的 target 是触发键，菜单收不到，
 * 一路冒泡到全局监听把文档标签 / 右栏关掉。所以菜单开着的时候在 document 捕获阶段认领 Esc：
 * 关菜单、preventDefault + stopPropagation，焦点在哪都一样。输入法组词中的 Esc 是取消组词，不接。
 */
export function isMenuDismissKey(event: Pick<KeyboardEvent, "key" | "isComposing">): boolean {
  return event.key === "Escape" && !event.isComposing;
}
