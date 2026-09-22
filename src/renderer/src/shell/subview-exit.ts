/**
 * 侧栏子视图（Archived / Carryovers）的自动退出判定。
 *
 * 单独成文件只为**可测**：`node --test` 只加载 `.ts`，判定写在 Sidebar.tsx 里就没法
 * 直接跑——而这条判定正是那个死胡同的所在，它必须有测试守着。
 */

/**
 * 子视图是否该自动退回主列表。
 *
 * **这是一个真实死胡同的修复**：进子视图的唯一入口是底部那条「Archived (N)」/
 * 「Carryovers (N)」，而它在 N 为 0 时是禁用的。把视图里最后一条清掉之后，
 * 列表空了、出口也禁用了——只剩一个空视图，点哪儿都出不去。
 *
 * 判定放在「空了就退」这一侧而不是「别禁用出口」一侧，是因为**一个空的存储位置
 * 视图本身就没有停留的理由**：归档为空时该看到的是主列表，不是一句「Nothing archived」。
 * （出口那一侧也一并修了：正在视图里时那条行永不禁用——那时它是「出来」不是「进去」。）
 *
 * 泛化自 Archived 专用的版本：Carryovers 面板是第二个消费者，两处同一个口径。
 */
export function shouldExitSubview(showing: boolean, count: number): boolean {
  return showing && count === 0;
}
