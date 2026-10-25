/**
 * 侧栏筛选的有效值（纯函数，Sidebar 唯一消费者）。
 *
 * 状态筛选只剩 All / Done：「进行中」2026-10-24 去掉（用户：「会话生命周期里的『进行中』似乎
 * 完全没用」）。状态从不落盘（Sidebar 的 useState，重启即回 All），没有旧值要迁移。
 */
export type StatusFilter = "all" | "done";

export interface SidebarFilterValues {
  status: StatusFilter;
  starredOnly: boolean;
  hasTodosOnly: boolean;
}

/** 解析当前有效筛选：**null = 不过滤**（三个值都是默认）。 */
export function effectiveSidebarFilters(values: SidebarFilterValues): SidebarFilterValues | null {
  if (values.status === "all" && !values.starredOnly && !values.hasTodosOnly) return null;
  return values;
}
