/**
 * 侧栏筛选的有效值（纯函数，Sidebar 唯一消费者）。
 *
 * 会话生命周期开关关闭时三件套（完成 / 星标 / 遗留）不存在：筛选行
 * 整行不渲染（五个 chip 里三个是三件套的直接入口，Active 依赖 done 概念，
 * All 单独存在没有意义），**残留的本地筛选状态也不该继续过滤列表**——用户
 * 选了 Done 筛选再去设置关开关，回来列表不该还窝在旧筛选里出不来。
 */
export type StatusFilter = "all" | "active" | "done";

export interface SidebarFilterValues {
  status: StatusFilter;
  starredOnly: boolean;
  hasTodosOnly: boolean;
}

/**
 * 解析当前有效筛选：**null = 不过滤**（列表全量、筛选行不渲染）。
 * 返回 null 的两种情况：开关关闭（上面注释的理由），或开着但三个值都是默认。
 */
export function effectiveSidebarFilters(
  lifecycle: boolean,
  values: SidebarFilterValues,
): SidebarFilterValues | null {
  if (!lifecycle) return null;
  if (values.status === "all" && !values.starredOnly && !values.hasTodosOnly) return null;
  return values;
}
