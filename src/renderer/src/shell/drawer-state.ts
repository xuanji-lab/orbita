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

/**
 * 新任务拿到真 id 之后把它收进停靠列表：有 "new" 占位就原位换掉，没有（App 存的列表里
 * 本来就不含占位）就追加到右端；已经在列表里则不动。
 */
export function adoptNewTab(docked: readonly DockedTab[], id: string): DockedTab[] {
  return dockTab(replaceNewTab(docked, id), id);
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

/** 胶囊右段列出的「其它标签」：停靠顺序不变，只是把当前激活的（住在胶囊左段当标题）拿掉 */
export function otherTabs(docked: readonly DockedTab[], active: DockedTab | null): DockedTab[] {
  return docked.filter((entry) => entry !== active);
}

/**
 * 标签上显示的名字：新任务占位用「新任务」，落盘会话取标题，查不到标题（会话列表还没
 * 载入 / 已被删）退回 id 前 6 位 + 省略号，免得标签是个空壳。
 */
export function tabLabel(tab: DockedTab, title: string | null, newTaskLabel: string): string {
  if (tab === NEW_TASK_TAB) return newTaskLabel;
  return title ?? `${tab.slice(0, 6)}…`;
}

/** 短 id（前 6 位，同主会话胶囊）；新任务占位还没有 id = null */
export function tabShortId(tab: DockedTab): string | null {
  return tab === NEW_TASK_TAB ? null : tab.slice(0, 6);
}
