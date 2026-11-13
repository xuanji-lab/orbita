import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { FocusSummaryRequest, FocusSummaryResult } from "@shared/focus";
import { focusClockAction, startFocusRun, extendFocusRun, summaryWindowOf, type FocusRun } from "./focus-timer.ts";

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
 *   失败后卡片给「重试」：素材窗口留着起跑那一刻的值（重试不用新时刻把窗口拖长），
 *   只有用户点才重发——自动通路只跑一次，不重复烧钱。
 * - **小结结果的代次（F1）**：`.then` / `.catch` / 重试全部带起跑那一刻的代次，
 *   `start()`（新一轮）与 `end()`（回 off）都会把代次作废——done 状态里小结还在
 *   跑时点「再专注一轮」，旧小结无论成功失败落回来都不覆盖新一轮的小结状态。
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
  /** failed 态点「重试」：沿用上一次的素材窗口重发（只由用户点，不自动重跑） */
  retrySummary: () => void;
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
  /** 最近一次起跑用的素材窗口：重试沿用它（窗口不随重试时刻变长） */
  const lastRequest = useRef<FocusSummaryRequest | null>(null);
  /**
   * 小结的代次：`start()` 与 `end()` 各 +1。在途请求（`.then` / `.catch`）落定时
   * 代次对不上就作废——旧一轮的小结（成功或失败）不覆盖新一轮的状态，`end()` 之后
   * 才到的结果也不写回。重试发生在同一轮里，代次不变，照常收。
   */
  const summaryGenRef = useRef(0);

  /** 起跑小结（唯一入口：run 相位自动 / ending 相位用户点「要」/ failed 态点「重试」） */
  const send = useCallback((request: FocusSummaryRequest): void => {
    lastRequest.current = request;
    const generation = summaryGenRef.current;
    setSummary({ state: "running" });
    void api.focus
      .summarize(request)
      .then((result) => {
        if (summaryGenRef.current !== generation) return;
        setSummary(summaryOf(result));
      })
      .catch((cause: unknown) => {
        if (summaryGenRef.current !== generation) return;
        setSummary({ state: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      });
  }, []);

  const fire = useCallback((run: FocusRun): void => send(summaryWindowOf(run, Date.now())), [send]);

  const retrySummary = useCallback((): void => {
    const request = lastRequest.current;
    // 按钮只在 failed 态出现；没有窗口（逻辑上到不了）就不发，宁可不动也不拿新窗口冒充那一次
    if (request !== null && summary.state === "failed") send(request);
  }, [send, summary.state]);

  /**
   * 自动起跑已发过的那一轮（按 run 对象身份记）。合盖唤醒 / Alt-Tab 回窗口时
   * `visibilitychange` 与 `focus` 在同一个任务里背靠背触发，两次 check() 的闭包里
   * `summary.state` 都还是旧值 idle（React 没来得及重渲染）——没有这个标记，小结
   * 会被自动发两次（隔离实例实测复现：两事件同任务派发 → focus:summarize 两遭，
   * 等于两次模型调用）。用户入口不经过 check()（ending 的「要」、failed 的「重试」
   * 都不走时钟），不受这个标记限制。
   */
  const autoFiredRunRef = useRef<FocusRun | null>(null);

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
      if (action.startSummary && autoFiredRunRef.current !== run) {
        autoFiredRunRef.current = run;
        fire(run);
      }
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
    // 新一轮：上一轮在途的小结（无论成功失败）落回来都不许写
    summaryGenRef.current += 1;
    lastRequest.current = null;
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
    // 回 off：在途的小结结果也不写回（没人消费它；下一次 start 会重置）
    summaryGenRef.current += 1;
    setStatus({ kind: "off" });
  }, []);

  return { status, summary, start, extend, earlyEnd, requestSummary, retrySummary, end, lastPreset };
}
