/**
 * Ctrl+Alt+D 开关辅助对话的判定。
 *
 * 为什么抽出来：macOS 上 Option（Alt）会改变 event.key——Option+D 产生 "∂"，
 * Shift+Option+D 产生 "Ï"——只看 key 在 mac 上永远匹配不到，快捷键形同虚设；
 * event.code（物理键位）不受 Option 影响，所以接受两者任一。严格放宽：
 * Windows 上 key 本来就是 "d"/"D"，行为不变。
 */
export function isDrawerToggleShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "key" | "code">): boolean {
  return event.ctrlKey && event.altKey && (event.key === "d" || event.key === "D" || event.code === "KeyD");
}
