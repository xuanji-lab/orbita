import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { FocusSummaryResult } from "@shared/focus";
import { focusClockAction, startFocusRun, extendFocusRun, type FocusRun } from "./focus-timer.ts";

/**
 * 专注计时的 hook（App 持有，工具栏左胶囊的 FocusControl 与左栏的文件视图共用）。
 *
 * - **状态不落盘**（用户裁决：关掉应用重开 = 已结束）——它只活在这里的 useState。
 * - **不向外暴露每秒跳动的 `now`**：App 只在相位变化时重渲染；秒针住在
 *   FocusControl 本地（`perf(focus)`：原来每秒 setNow 把整棵 App 提起来重画）。
 *   到点转 done / T-5 起跑小结由下面那个每秒对墙上时间的 effect 决定。四个相位：
 *   `run`（在跑）/ `ending`（提前结束、等用户决定要不要总结，计时停）/
 *   `done`（时间到）/ `off`。
 * - **收工小结**（PR B）：run 相位剩 5 分钟自动起跑（原型状态 8）；ending 相位
 *   由用户点「要」再跑（素材窗口 = 专注开始 → 起跑那一刻）。结果四态：
 *   ready（3–5 条要点）/ failed / none（没素材或没配模型，诚实退路）/ running。
 *   到点还没跑完不补跑不重跑——卡片先出「正在整理」，转圈等它。
 * - `lastPreset` 记上一次开始用的时长与工作区：「再专注一轮」沿用（原型状态 9）。
 */
export type FocusStatus =
  | { kind: "off" }
  | { kind: "run"; run: FocusRun }
  | { kind: "ending"; run: FocusRun }
  | { kind: "done"; run: FocusRun };

export type FocusSummary =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ready"; bullets: string[]; sessionsRead: number; modelLabel: string }
  | { state: "failed"; message: string }
  | { state: "none"; reason: "no-activity" | "no-model" };

export interface FocusApi {
  status: FocusStatus;
  summary: FocusSummary;
  start: (workspaceId: string, minutes: number) => void;
  extend: (minutes: number) => void;
  /** 时间到 / 延长线的自然路径之外，把表停住等总结决定（胶囊浮层的「提前结束」） */
  earlyEnd: () => void;
  /** ending 相位点「要」：立刻起跑小结（run 相位不用它——那是自动的） */
  requestSummary: () => void;
  /** 回到 off：ending 的「不要」、卡片的「结束专注」、「再专注一轮」之前的复位 */
  end: () => void;
  /** 上一次开始专注的档位（「再专注一轮」沿用）；从没专注过是 null */
  lastPreset: { workspaceId: string; minutes: number } | null;
}

function summaryOf(result: FocusSummaryResult): FocusSummary {
  if (result.kind === "ok") {
    return { state: "ready", bullets: result.bullets, sessionsRead: result.sessionsRead, modelLabel: result.modelLabel };
  }
  if (result.kind === "empty") return { state: "none", reason: result.reason };
  return { state: "failed", message: result.message };
}

export function useFocus(): FocusApi {
  const [status, setStatus] = useState<FocusStatus>({ kind: "off" });
  const [summary, setSummary] = useState<FocusSummary>({ state: "idle" });
  const [lastPreset, setLastPreset] = useState<{ workspaceId: string; minutes: number } | null>(null);

  /** 起跑小结（唯一入口：run 相位自动 / ending 相位用户点「要」） */
  const fire = useCallback((run: FocusRun): void => {
    setSummary({ state: "running" });
    void api.focus
      .summarize({ startedAt: run.startedAt, until: Date.now(), workspaceId: run.workspaceId })
      .then((result) => setSummary(summaryOf(result)))
      .catch((cause: unknown) => {
        setSummary({ state: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      });
  }, []);

  /**
   * 专注时钟：run 相位每秒对一次**墙上时间**（`Date.now()`），只在跨过 T-5 / 到点
   * 时才 setState（`focusClockAction`，纯函数带测试）——剩下的拍子连一次渲染都不花，
   * `perf(focus)` 的省电结论不变。
   *
   * 为什么不再按截止时刻排一次性 `setTimeout`：定时器算的是「还要过多久」，电脑
   * 合盖睡眠期间它不走，睡多久到点就晚多久（合盖一夜，回来才响）。现在定时器只是
   * 叫醒：合盖期间 interval 也不跑，但醒来后第一拍（或 `visibilitychange` /
   * window `focus`）立刻对表，越过 T-5 就补跑小结、越过 endsAt 就转 done。
   *
   * endsAt 上那个一次性 timeout 是**后台兜底**，不是判断依据：窗口藏起来时 Chromium
   * 会把 1 秒 interval 降到约一分钟一拍，到点通知会晚最多一分钟；这个定时器到点只
   * 调一次 check（判断仍看墙上时间），所以睡眠越过它也不会错。窗口在后台到点照样转
   * done 并发系统通知（App 那一侧看 `isWindowInactive`）。
   */
  useEffect(() => {
    if (status.kind !== "run") return;
    const run = status.run;
    const check = (): void => {
      const action = focusClockAction(run, Date.now(), summary.state === "idle");
      if (action.startSummary) fire(run);
      if (action.finish) setStatus({ kind: "done", run });
    };
    check();
    const ticker = window.setInterval(check, 1000);
    const backstop = window.setTimeout(check, Math.max(0, run.endsAt - Date.now()));
    const onWake = (): void => {
      if (document.visibilityState !== "hidden") check();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      window.clearInterval(ticker);
      window.clearTimeout(backstop);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [status, summary.state, fire]);

  const start = useCallback((workspaceId: string, minutes: number): void => {
    const next = startFocusRun(Date.now(), workspaceId, minutes);
    setLastPreset({ workspaceId, minutes });
    setSummary({ state: "idle" });
    setStatus({ kind: "run", run: next });
  }, []);

  const extend = useCallback((minutes: number): void => {
    // done / ending 之后没有延长入口（胶囊停「时间到」，点不开）；函数式更新防连点丢拍
    setStatus((current) =>
      current.kind === "run" ? { kind: "run", run: extendFocusRun(current.run, minutes) } : current,
    );
  }, []);

  const earlyEnd = useCallback((): void => {
    setStatus((current) => (current.kind === "run" ? { kind: "ending", run: current.run } : current));
  }, []);

  const requestSummary = useCallback((): void => {
    if (status.kind === "ending" && summary.state === "idle") fire(status.run);
  }, [status, summary.state, fire]);

  const end = useCallback((): void => {
    setStatus({ kind: "off" });
    // 小结状态留着不重置：ending 的「不要」之后卡在 running 的请求落回 ready 时
    // 没人消费——下一次 start 会重置，这里不清也无人再读
  }, []);

  return { status, summary, start, extend, earlyEnd, requestSummary, end, lastPreset };
}
