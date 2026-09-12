/**
 * 右侧面板（辅助对话槽）的纯逻辑 —— 停靠标签的增删改。
 * 与 React 无关，node --test 直接测（host-core.ts 同款先例）。
 */

/**
 * 抽屉里开着的标签。**字符串 id = 已存在的 task**；
 * `"new"` = 还没发出第一句话的新任务（发出去拿到 id 后被替换，见 replaceNewTab）。
 */
export type DockedTab = string | "new";
export const NEW_TASK_TAB: DockedTab = "new";

/** 停靠一条 task：已在就不动（顺序即标签顺序，新的在右） */
export function dockTab(docked: readonly DockedTab[], tab: DockedTab): DockedTab[] {
  return docked.includes(tab) ? [...docked] : [...docked, tab];
}

/** 关一个标签：其余保持原顺序 */
export function closeTab(docked: readonly DockedTab[], tab: DockedTab): DockedTab[] {
  return docked.filter((entry) => entry !== tab);
}

/** 新任务发出了第一句话、拿到了真 id：把 "new" 占位换成它。没有占位就不动。 */
export function replaceNewTab(docked: readonly DockedTab[], id: string): DockedTab[] {
  const index = docked.indexOf(NEW_TASK_TAB);
  if (index === -1) return [...docked];
  return docked.map((entry, at) => (at === index ? id : entry));
}

/** 关掉一个标签后激活谁：右邻优先，没有就左邻，空了就是没有 */
export function neighborTab(
  docked: readonly DockedTab[],
  closed: DockedTab,
): DockedTab | null {
  const index = docked.indexOf(closed);
  if (index === -1) return docked.length > 0 ? (docked[docked.length - 1] ?? null) : null;
  return docked[index + 1] ?? docked[index - 1] ?? null;
}
