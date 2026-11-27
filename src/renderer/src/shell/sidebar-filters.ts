/**
 * 侧栏筛选的有效值（纯函数，Sidebar 唯一消费者）。
 *
 * 筛选只剩两样：星标（叠加开关）与时间范围。曾有的「已完成」（2026-10-24 去掉「进行中」后只剩它）与
 * 「有待办」（遗留事项）已随会话「完成」与遗留事项一起删除（2026-11-22）。星标不落盘（Sidebar 的
 * useState，重启即回不过滤）。
 */
import type { SidebarAgeDays } from "../../../shared/settings.ts";

export interface SidebarFilterValues {
  starredOnly: boolean;
  /**
   * 时间范围（2026-11-07 起）：只列最近 N 天动过的。null = 不限。与星标不同，它**落盘**
   * （settings.sidebarAgeDays，用户要「选了记住」）。
   */
  ageDays: SidebarAgeDays | null;
}

/** 解析当前有效筛选：**null = 不过滤**（两个值都是默认）。 */
export function effectiveSidebarFilters(values: SidebarFilterValues): SidebarFilterValues | null {
  if (!values.starredOnly && values.ageDays === null) return null;
  return values;
}
