/**
 * Archived 视图的出入判定。
 *
 * 单独成文件只为**可测**：`node --test` 只加载 `.ts`，判定写在 Sidebar.tsx 里就没法
 * 直接跑——而这条判定正是 main 上那个死胡同的所在，它必须有测试守着。
 */

/**
 * Archived 视图是否该自动退回主列表。
 *
 * **这是 main 上一个真实死胡同的修复**：进入 Archived 的唯一入口是底部那条
 * 「Archived (N)」，而它在 `archived.length === 0` 时是禁用的。把视图里最后一条
 * unarchive 掉之后，列表空了、出口也禁用了——只剩一个空视图，点哪儿都出不去。
 *
 * 判定放在「空了就退」这一侧而不是「别禁用出口」一侧，是因为**一个空的存储位置
 * 视图本身就没有停留的理由**：归档为空时该看到的是主列表，不是一句「Nothing archived」。
 */
export function shouldExitArchived(showArchived: boolean, archivedCount: number): boolean {
  return showArchived && archivedCount === 0;
}
