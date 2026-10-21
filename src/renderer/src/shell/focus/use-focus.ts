import { useCallback, useEffect, useState } from "react";
import { startFocusRun, extendFocusRun, type FocusRun } from "./focus-timer.ts";

/**
 * 专注计时的 hook（App 持有，Sidebar 顶行与收起态页头的窗口工具组共用同一份）。
 *
 * - **状态不落盘**（用户裁决：关掉应用重开 = 已结束）——它只活在这里的 useState。
 * - run 期间每秒跳一拍 `now`（倒计时数字每秒换一次，不动画）；到点转 done，
 *   计时停（done 停在「时间到」，不再跳）。到点那一刻要做什么（响铃 / 通知 /
 *   展开侧栏）不在这里——App 用 effect 盯 `status.kind === "done"`，本 hook 只管时间。
 * - `lastPreset` 记上一次开始用的时长与工作区：「再专注一轮」沿用（原型状态 9）。
 */
export type FocusStatus = { kind: "off" } | { kind: "run"; run: FocusRun } | { kind: "done"; run: FocusRun };

export interface FocusApi {
  status: FocusStatus;
  /** 每秒跳动的当前时刻（只在 run 期间跳动）；done 后停在到点那一拍 */
  now: number;
  start: (workspaceId: string, minutes: number) => void;
  extend: (minutes: number) => void;
  /** 回到 off：提前结束与「结束专注」共用（界面上两者本来就不是一个动作两个名字，是一个动作） */
  end: () => void;
  /** 上一次开始专注的档位（「再专注一轮」沿用）；从没专注过是 null */
  lastPreset: { workspaceId: string; minutes: number } | null;
}

export function useFocus(): FocusApi {
  const [status, setStatus] = useState<FocusStatus>({ kind: "off" });
  const [now, setNow] = useState(() => Date.now());
  const [lastPreset, setLastPreset] = useState<{ workspaceId: string; minutes: number } | null>(null);

  // 计时：run 期间每秒一拍。status 对象换了（开始 / 延长 / 到点）重排一拍，其余时间
  // 同一个 interval 稳定地走——不依赖 now 写回，避免「setNow → effect 重跑」的环
  useEffect(() => {
    if (status.kind !== "run") return;
    const run = status.run;
    const tick = (): void => {
      const current = Date.now();
      setNow(current);
      // 到点：转 done。比较用 run.endsAt（闭包里的那一份），不读 state——这一拍
      // 之前可能连着几次 setNow，闭包不会过期（effect 只在 status 换对象时重建）
      if (current >= run.endsAt) setStatus({ kind: "done", run });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  const start = useCallback((workspaceId: string, minutes: number): void => {
    const next = startFocusRun(Date.now(), workspaceId, minutes);
    setLastPreset({ workspaceId, minutes });
    setStatus({ kind: "run", run: next });
  }, []);

  const extend = useCallback((minutes: number): void => {
    // done 之后没有延长入口（胶囊停「时间到」，点不开）；函数式更新防连点丢拍
    setStatus((current) =>
      current.kind === "run" ? { kind: "run", run: extendFocusRun(current.run, minutes) } : current,
    );
  }, []);

  const end = useCallback((): void => {
    setStatus({ kind: "off" });
  }, []);

  return { status, now, start, extend, end, lastPreset };
}
