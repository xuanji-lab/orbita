import type { IconName } from "./Icon";
import type { Messages } from "../messages-en.ts";

/**
 * 会话行**行首状态槽**里该画什么。
 *
 * 2026-10-10 二轮（用户裁决）：运行中实心点、未读圈勾、失败三角全部撤掉——
 * 运行态改由行最左侧的**状态饼**表达（completion-notice.ts 的 sessionRunState，
 * 与右下角铃铛清单同一份真源）。槽里只剩两样静态标记：
 *
 * subRunning > pinned > 空。
 *
 * - subRunning（任一直接子会话在跑，画 git-fork）：状态饼这时也亮 1/3 蓝（子会话
 *   在跑算母会话在跑），fork 图标补的那一句是「跑的是孩子」。
 * - pinned 只是排序偏好，排最后。
 * - **idle / running / failed / unread 都不在这里**：状态饼说了，行首再画一个图标
 *   就是对同一事实的第二次陈述（颜色是第二信号，不是图标是第二信号）。
 *   **done 也不在这里**（2026-09-22 wafo）：完成是用户亲手点的标记，与星标
 *   同槽、同规则，画在行尾。
 *
 * **空槽也占位**（调用方渲染一个等宽空槽），否则有标记的行和没标记的行标题不对齐。
 *
 * 抽成纯函数是为了能测：优先级是这套显示里唯一会被改错的地方，它必须有测试守着。
 */
export type RowStatus = {
  icon: IconName;
  /** CSS 变量名，不写裸色（设计系统硬规则） */
  tone: string;
  /** 图标槽的 tooltip，也是这一档的可读名字 */
  label: string;
};

export function rowStatusIcon(
  state: {
    /** 任一直接子会话在跑（母会话自己的行用；子会话自己的行恒 false） */
    subRunning: boolean;
    pinned: boolean;
  },
  t: Messages,
): RowStatus | null {
  // 子会话在跑：git-fork（与 Sub-sessions 面板入口同一个图标）。颜色跟状态饼的
  // running 同一个 token（--color-info）——一条事实一种颜色，暗色主题的 accent
  // 是黄，不拿它说「在跑」
  if (state.subRunning)
    return { icon: "git-fork", tone: "var(--color-info)", label: t.rowStatus.subRunning };
  if (state.pinned)
    return { icon: "pin", tone: "var(--color-text-secondary)", label: t.rowStatus.pinned };
  return null;
}
