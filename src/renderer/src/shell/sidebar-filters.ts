/**
 * 侧栏筛选的有效值（纯函数，Sidebar 唯一消费者）。
 *
 * 状态筛选只剩 All / Done：「进行中」2026-10-24 去掉（用户：「会话生命周期里的『进行中』似乎
 * 完全没用」）。状态从不落盘（Sidebar 的 useState，重启即回 All），没有旧值要迁移。
 */
import type { SidebarAgeDays } from "../../../shared/settings.ts";

export interface SidebarFilterValues {
  starredOnly: boolean;
  /**
   * 时间范围（2026-11-07 起）：只列最近 N 天动过的。null = 不限。与星标不同，它**落盘**
   * （settings.sidebarAgeDays，用户要「选了记住」）；星标仍是 Sidebar 的 useState。
   */
  ageDays: SidebarAgeDays | null;
}

/** 解析当前有效筛选：**null = 不过滤**（三个值都是默认）。 */
export function effectiveSidebarFilters(values: SidebarFilterValues): SidebarFilterValues | null {
  if (!values.starredOnly && values.ageDays === null) return null;
  return values;
}
