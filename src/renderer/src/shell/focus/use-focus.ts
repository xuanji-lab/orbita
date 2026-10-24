import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { FocusSummaryRequest, FocusSummaryResult } from "@shared/focus";
import {
  SUMMARY_LEAD_MS,
  startFocusRun,
  extendFocusRun,
  shouldStartSummary,
  summaryWindowOf,
  type FocusRun,
} from "./focus-timer.ts";

/**
 * 专注计时的 hook（App 持有，工具栏左胶囊的 FocusControl 与左栏的文件视图共用）。
 *
 * - **状态不落盘**（用户裁决：关掉应用重开 = 已结束）——它只活在这里的 useState。
 * - **不向外暴露每秒跳动的 `now`**：App 只在相位变化时重渲染；秒针住在
 *   FocusControl 本地（`perf(focus)`：原来每秒 setNow 把整棵 App 提起来重画）。
 *   到点转 done 靠 endsAt 上的一个 setTimeout。四个相位：
 *   `run`（在跑）/ `ending`（提前结束、等用户决定要不要总结，计时停）/
 *   `done`（时间到）/ `off`。
 * - **收工小结**（PR B）：run 相位剩 5 分钟自动起跑（原型状态 8）；ending 相位
 *   由用户点「要」再跑（素材窗口 = 专注开始 → 起跑那一刻）。结果四态：
 *   ready（3–5 条要点）/ failed / none（没素材或没配模型，诚实退路）/ running。
 *   到点还没跑完不补跑不重跑——卡片先出「正在整理」，转圈等它。
 *   失败后卡片给「重试」：素材窗口留着起跑那一刻的值（重试不用新时刻把窗口拖长），
 *   只有用户点才重发——自动通路只跑一次，不重复烧钱。
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

  // 到点转 done：在 endsAt 上排一个 setTimeout（原来搭每秒那一拍的顺风车）。
  // status 换了（开始 / 延长）就清掉重排，延长不会提前收工。
  useEffect(() => {
    if (status.kind !== "run") return;
    const run = status.run;
    const delay = run.endsAt - Date.now();
    if (delay <= 0) {
      setStatus({ kind: "done", run });
      return;
    }
    const timer = window.setTimeout(() => setStatus({ kind: "done", run }), delay);
    return () => window.clearTimeout(timer);
  }, [status]);

  /** 起跑小结（唯一入口：run 相位自动 / ending 相位用户点「要」/ failed 态点「重试」） */
  const send = useCallback((request: FocusSummaryRequest): void => {
    lastRequest.current = request;
    setSummary({ state: "running" });
    void api.focus
      .summarize(request)
      .then((result) => setSummary(summaryOf(result)))
      .catch((cause: unknown) => {
        setSummary({ state: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      });
  }, []);

  const fire = useCallback((run: FocusRun): void => send(summaryWindowOf(run, Date.now())), [send]);

  const retrySummary = useCallback((): void => {
    const request = lastRequest.current;
    // 按钮只在 failed 态出现；没有窗口（逻辑上到不了）就不发，宁可不动也不拿新窗口冒充那一次
    if (request !== null && summary.state === "failed") send(request);
  }, [send, summary.state]);

  // 自动起跑：剩 5 分钟（shouldStartSummary 也含到点之后——补跑）。按
  // endsAt − SUMMARY_LEAD_MS 排一个 setTimeout，相位变化（开始 / 延长）时重排；
  // 进窗口时若还没起跑（补跑）就立刻起跑——语义与原来逐秒判断一致，只是不再
  // 靠每秒跳动的 now。
  useEffect(() => {
    if (status.kind !== "run" || summary.state !== "idle") return;
    const run = status.run;
    if (shouldStartSummary(run, Date.now())) {
      fire(run);
      return;
    }
    const timer = window.setTimeout(() => fire(run), run.endsAt - SUMMARY_LEAD_MS - Date.now());
    return () => window.clearTimeout(timer);
  }, [status, summary.state, fire]);

  const start = useCallback((workspaceId: string, minutes: number): void => {
    const next = startFocusRun(Date.now(), workspaceId, minutes);
    setLastPreset({ workspaceId, minutes });
    lastRequest.current = null;
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

  return { status, summary, start, extend, earlyEnd, requestSummary, retrySummary, end, lastPreset };
}
