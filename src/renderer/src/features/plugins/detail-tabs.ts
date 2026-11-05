/**
 * 插件详情的页签规则（纯函数，单独成文件只为可测）。
 *
 * 三个页签：面板 / 工作流 / 设置与来源。没有面板的插件没有「面板」页签；旧技能 / 旧 MCP 不是真插件，
 * 没有工作流也没有面板，不分页签（调用方拿到空数组就把能展示的内容平铺）。
 * 默认选中：有面板就是面板（用户进详情最想看的是它长什么样），没有就是第一个。
 */
export type DetailTab = "panel" | "workflow" | "settings";

/** 这个条目有哪些页签，按显示顺序。`hasPanel` = 清单声明了 orbita.panel（哪怕声明有问题——问题要在面板页签里看见）。 */
export function detailTabs(args: { isPlugin: boolean; hasPanel: boolean }): DetailTab[] {
  if (!args.isPlugin) return [];
  return args.hasPanel ? ["panel", "workflow", "settings"] : ["workflow", "settings"];
}

/** 默认页签：第一个（有面板时面板排第一）。没有页签返回 null。 */
export function defaultDetailTab(tabs: readonly DetailTab[]): DetailTab | null {
  return tabs[0] ?? null;
}

/**
 * 实际显示哪一页：想要的页签（用户点的 / 「在右栏打开面板」指定的）在页签里就用它，不在（插件没有面板、
 * 面板声明被删了）退回默认。
 */
export function resolveDetailTab(tabs: readonly DetailTab[], wanted: DetailTab | null): DetailTab | null {
  if (wanted !== null && tabs.includes(wanted)) return wanted;
  return defaultDetailTab(tabs);
}

/** 方向键切页签（循环）：返回下一个页签；当前不在页签里就从第一个起。 */
export function stepDetailTab(tabs: readonly DetailTab[], current: DetailTab | null, delta: 1 | -1): DetailTab | null {
  if (tabs.length === 0) return null;
  const index = current === null ? -1 : tabs.indexOf(current);
  if (index === -1) return tabs[0] ?? null;
  return tabs[(index + delta + tabs.length) % tabs.length] ?? null;
}
