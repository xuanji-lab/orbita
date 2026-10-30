/**
 * 专注 shell 的纯推导：App 只剩接线之后，「此刻该看哪一屏、星云该说什么、
 * 收工卡出不出」这些判定都住在这里（带 `node --test`）。
 *
 * 为什么单拉一份：专注有两个入口（工具栏的闪电、浏览态的「以此开始专注」）与
 * 四条出口（提前结束的要 / 不要、到点的结束 / 再专注一轮），散在 App 里时两处
 * 判定各写一遍，已经因此不一致过一次（#267 B3：`startFocus` 忘了退设置页）。
 * 接线收进 `use-focus-shell.tsx`，判定收进这里——两边都不再各写一份。
 */
import type { FocusRun } from "../../shell/focus/focus-timer.ts";
import { focusSayOf } from "../../shell/focus/focus-say.ts";
import type { FocusStatus, FocusSummary } from "../../shell/focus/use-focus.ts";
import type { Messages } from "../../messages-en.ts";

/** 左栏此刻该显示的工作区文件视图；null = 会话列表 */
export type FocusFilesView = { mode: "browse" | "focus"; workspaceId: string };

/**
 * 左栏此刻的文件视图：专注中 = 所选工作区（run / ending / done 都留在这个视图上，
 * 到点出卡时左栏不动）；否则看浏览态；都没有 = 会话列表。
 */
export function focusFilesViewOf(status: FocusStatus, wsBrowse: string | null): FocusFilesView | null {
  if (status.kind !== "off") return { mode: "focus", workspaceId: status.run.workspaceId };
  if (wsBrowse === null) return null;
  return { mode: "browse", workspaceId: wsBrowse };
}

/** 星云头顶此刻该说的那句话（`focus-say.ts` 只管 run 相位，这里把 ending 的问询也收进来） */
export type FocusBubbleView =
  | { kind: "hidden" }
  /** 转圈那句；breath = 气泡里的字缓慢呼吸（run 相位有，ending 相位没有） */
  | { kind: "working"; breath: boolean }
  | { kind: "settled"; line: "ready" | "failed" | "no-activity" | "no-model" }
  /** ending + 小结还没跑：问一句要不要总结 */
  | { kind: "ask" };

/**
 * 气泡的四种形态，判定顺序与原 App 的 JSX 三元链一致：
 * run（focus-say 的常驻气泡）→ ending + idle 的问询 → ending + running 的转圈。
 */
export function focusBubbleOf(
  status: FocusStatus,
  summary: FocusSummary,
  dismissed: boolean,
): FocusBubbleView {
  if (status.kind === "run") {
    const view = focusSayOf(status, summary, dismissed);
    if (view.kind === "running") return { kind: "working", breath: true };
    if (view.kind === "settled") return { kind: "settled", line: view.line };
    return { kind: "hidden" };
  }
  if (status.kind === "ending") {
    if (summary.state === "idle") return { kind: "ask" };
    // ending 相位的转圈没有呼吸那一下（原 JSX 里两个 span 的类名不同）
    if (summary.state === "running") return { kind: "working", breath: false };
  }
  return { kind: "hidden" };
}

/**
 * 收工卡出不出现：时间到（总结还没跑完也先出，卡里转圈）；提前结束点了「要」且
 * 落定（ready / failed / none）后才出。卡自己的关闭键压住它——只藏卡，不结束专注。
 */
export function focusCardVisibleOf(status: FocusStatus, summary: FocusSummary, cardClosed: boolean): boolean {
  if (cardClosed) return false;
  if (status.kind === "done") return true;
  if (status.kind !== "ending") return false;
  return (
    summary.state === "ready" ||
    summary.state === "failed" ||
    summary.state === "none"
  );
}

/**
 * 卡顶那行「N 分钟」：到点用这一轮的总时长（含延长）；提前结束用已经跑过的墙钟
 * 时间，至少 1 分钟（「提前结束 · 0 分钟」读起来像没开始）。
 */
export function focusCardMinutesOf(status: FocusStatus, run: FocusRun, now: number): number {
  if (status.kind === "done") return Math.round(run.totalMs / 60_000);
  return Math.max(1, Math.round((now - run.startedAt) / 60_000));
}

/** 落定气泡 / 卡里那句诚实退路；ready 之外都是「这次没总结成」的不同理由 */
export function settledSayTextOf(line: "ready" | "failed" | "no-activity" | "no-model", focus: Messages["focus"]): string {
  if (line === "ready") return focus.sayReady;
  if (line === "failed") return focus.summaryFailed;
  if (line === "no-model") return focus.summaryNoModel;
  return focus.summaryNoActivity;
}

/**
 * 睡眠即结束专注（用户 2026-10-28 裁决）：suspend 信号到的那一刻，在跑的那一轮
 * 该怎么收。按「提前结束」处理但不走 ending 的问询：人已经睡着了，问句没人答，
 * 醒来也不该弹浮层——直接回 off，左栏落到同一工作区的**浏览态**（醒来看到的是
 * 刚才在专心的那个工作区，只是不再计时）。不在跑（off / ending / done）就不用动：
 * ending 的问句与 done 的卡是醒着时留下的界面，睡眠不清理它们。
 */
export function focusSuspendActionOf(status: FocusStatus): { kind: "end-to-browse"; workspaceId: string } | null {
  if (status.kind !== "run") return null;
  return { kind: "end-to-browse", workspaceId: status.run.workspaceId };
}
