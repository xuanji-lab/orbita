/**
 * 星云「正在整理」气泡的纯状态机（用户 2026-10-19 验收：「我没看到星云在剩下
 * 五分钟的时候说话嘞。应该显示个正在整理，然后有个状态，状态结束了……用户可以
 * 点掉，也可以不管」）。
 *
 * 根因：气泡原先只挂 summary 的 running 态——模型十秒级跑完就退场，人看不到。
 * 现在起跑后**常驻**：running（转圈 / 呼吸）→ 落定（ready / failed / none 各一句
 * 诚实文案 + 关闭键），点了 x 才消失。到点弹不弹卡与气泡无关（被点掉也照样弹，
 * 「重新 pop up」）——卡片可见性另有其账（App 的 summaryCardClosed）。
 *
 * 纯函数：类型从 use-focus 以 **type-only** 引入（运行时剥掉，node --test 可直接加载）。
 */
import type { FocusStatus, FocusSummary } from "./use-focus.ts";

export type FocusSayView =
  | { kind: "hidden" }
  | { kind: "running" }
  /** 落定态：line 决定那句话（ready = 整理好了；其余为诚实退路） */
  | { kind: "settled"; line: "ready" | "failed" | "no-activity" | "no-model" };

/**
 * 此刻星云头顶该显示什么。只在 run 相位出（ending 的问询是另一套气泡，done 出卡
 * 不出气泡）；点了 x（dismissed）就 hidden，但 summary 状态照旧——到点的卡不受影响。
 */
export function focusSayOf(
  status: FocusStatus,
  summary: FocusSummary,
  dismissed: boolean,
): FocusSayView {
  if (status.kind !== "run") return { kind: "hidden" };
  if (dismissed) return { kind: "hidden" };
  if (summary.state === "running") return { kind: "running" };
  if (summary.state === "ready") return { kind: "settled", line: "ready" };
  if (summary.state === "failed") return { kind: "settled", line: "failed" };
  if (summary.state === "none") return { kind: "settled", line: summary.reason };
  return { kind: "hidden" };
}

/**
 * 到点弹不弹总结卡：**总是弹**（除非用户点过卡自己的关闭键——那是另一份账）。
 * 气泡被点掉不影响：没点掉 = 气泡位置展开成卡；点掉了 = 重新 pop up。
 */
export function cardPopsAtDone(status: FocusStatus, cardClosed: boolean): boolean {
  if (status.kind !== "done") return false;
  return !cardClosed;
}
