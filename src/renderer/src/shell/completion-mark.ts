import type { SessionCompletion } from "@shared/session";

/**
 * 行内完成标记点一下之后落到哪个状态。
 *
 * **标记是开关，不是三选一的菜单**：点一下标完成，再点一下就是 Reopen。
 * 所以两个「已完成」的档（done / done_with_todos）都回 open——
 * 遗留事项是完成时扫出来的附加信息，不是另一个需要用户在行里挑的目的地。
 *
 * 抽成纯函数是为了能测：这是「点一下」的全部语义，写在 Sidebar.tsx 的 onClick
 * 里就只能靠手点验证。类型是 type-only import，node --test 加载时会被剥掉。
 */
export function nextCompletion(current: SessionCompletion): SessionCompletion {
  return current === "open" ? "done" : "open";
}
