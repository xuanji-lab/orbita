import type { IconName } from "./Icon";

/**
 * 会话行**行首状态槽**里该画什么。槽只有一个位置，而能落进来的事实有四种，
 * 所以它是一条**优先级链**而不是四个并列的 if：
 *
 * running > failed > done > pinned > 空。
 *
 * 理由分两截。前两档是「正在发生的事」：跑着和跑挂了都是此刻的状态，
 * 它们比任何静态标记更该被看见。后两档是「用户留下的标记」：done 是任务
 * 的终局，pinned 只是排序偏好——一条又置顶又完成的会话，先告诉人它做完了。
 *
 * **idle 不画东西**（2026-09-22 wafo）：以前 idle 画一个灰勾，而灰勾既不表示完成、
 * 也不表示别的，一列灰勾只是噪音；勾这个形状被收回去专门表示完成，颜色给 accent。
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

export function rowStatusIcon(state: {
  running: boolean;
  failed: boolean;
  done: boolean;
  pinned: boolean;
}): RowStatus | null {
  if (state.running)
    return { icon: "loader-circle", tone: "var(--color-accent)", label: "Running", spin: true };
  if (state.failed)
    return { icon: "triangle-alert", tone: "var(--color-danger)", label: "Failed", spin: false };
  if (state.done) return { icon: "check", tone: "var(--color-accent)", label: "Done", spin: false };
  if (state.pinned)
    return { icon: "pin", tone: "var(--color-text-secondary)", label: "Pinned", spin: false };
  return null;
}
