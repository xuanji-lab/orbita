import type { IconName } from "./Icon";
import type { Messages } from "../messages-en.ts";

/**
 * 会话行**行首状态槽**里该画什么。槽只有一个位置，而能落进来的事实有五种，
 * 所以它是一条**优先级链**而不是并列的 if：
 *
 * running > subRunning > failed > pinned > 空。
 *
 * 理由：前三档都是「正在发生的事」，比任何静态标记更该被看见。父会话自己在跑
 * （running）压过一切；父空闲但有任一直接子会话在跑（subRunning，画 git-fork）
 * 压过 failed——子会话此刻的活是正在发生的事，母会话上一轮的失败等子会话停下来
 * 再说；pinned 只是排序偏好，排最后。**done 不在这里**（2026-09-22 wafo）：完成
 * 是用户亲手点的标记，与星标同槽、同规则，画在行尾，行首不再重复。
 *
 * **idle 不画东西**（2026-09-22 wafo）：以前 idle 画一个灰勾，一列灰勾只是噪音。
 * 槽本身仍然占位（调用方渲染一个等宽空槽），否则有标记的行和没标记的行标题不对齐。
 *
 * 抽成纯函数是为了能测：优先级是这套显示里唯一会被改错的地方，它必须有测试守着。
 */
export type RowStatus = {
  icon: IconName;
  /** CSS 变量名，不写裸色（设计系统硬规则） */
  tone: string;
  /** 图标槽的 tooltip，也是这一档的可读名字 */
  label: string;
  spin: boolean;
};

export function rowStatusIcon(
  state: {
    running: boolean;
    /** 任一直接子会话在跑（母会话自己的行用；子会话自己的行恒 false） */
    subRunning: boolean;
    failed: boolean;
    pinned: boolean;
  },
  t: Messages,
): RowStatus | null {
  // 静态标记，不转圈（2026-09-23，去 blur 的连带改动）：侧栏行是后台会话运行时
  // 屏上唯一常驻的动效，窗口在前台但没人盯着这一行时它仍在转，GPU 每帧整窗重新
  // 合成——停在会话页看得到「Responding」转圈，这里换成实心点，颜色仍是 accent。
  if (state.running)
    return { icon: "circle-dot", tone: "var(--color-accent)", label: t.common.running, spin: false };
  // 子会话在跑：母会话行首画 git-fork（与 Sub-sessions 面板入口同一个图标）。
  // 父与子同时在跑时用上一档（running）——说的是母会话自己。同样静态不转，理由
  // 同上；压过 failed 的理由见优先级链的注释。
  if (state.subRunning)
    return { icon: "git-fork", tone: "var(--color-accent)", label: t.rowStatus.subRunning, spin: false };
  if (state.failed)
    return { icon: "triangle-alert", tone: "var(--color-danger)", label: t.common.failed, spin: false };
  if (state.pinned)
    return { icon: "pin", tone: "var(--color-text-secondary)", label: t.rowStatus.pinned, spin: false };
  return null;
}
