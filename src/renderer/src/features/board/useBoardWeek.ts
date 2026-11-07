import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { BoardWeekResponse } from "../../../../shared/plugin-board.ts";

/**
 * 全局周看板的数据钩子（`board:week` 的 renderer 端）。界面在后续的看板视图里接。
 *
 * 「拉一次 + 自动化一变就重拉」：自动化跑完 / 开跑 / 被改，主进程都会广播 automation 的 changed，
 * 运行记录与排期都跟着变，所以听同一个事件。另外每分钟重拉一次——「今天剩下的排期」会随时间推移
 * 变成过去（planned 只给晚于此刻的），不重拉的话过了点的灰字会一直挂着。
 *
 * `weekStart` 传当地周一 00:00（`localWeekStart(Date.now())` 算）；主进程会再规整一次。
 */
export type BoardWeekState =
  | { kind: "loading" }
  | { kind: "ready"; week: BoardWeekResponse }
  | { kind: "failed"; message: string };

const REFRESH_MS = 60_000;

export function useBoardWeek(weekStart: number): { state: BoardWeekState; reload: () => void } {
  const [state, setState] = useState<BoardWeekState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => api.automation.onEvent(() => setNonce((value) => value + 1)), []);
  useEffect(() => {
    const timer = setInterval(() => setNonce((value) => value + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    api.board
      .week({ weekStart })
      .then((week) => {
        if (!live) return;
        setState(week === null ? { kind: "failed", message: "invalid week" } : { kind: "ready", week });
      })
      .catch((cause: unknown) => {
        if (live) setState({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      live = false;
    };
  }, [weekStart, nonce]);

  // 换周时先回 loading，免得上一周的数据挂在新的标题下
  useEffect(() => setState({ kind: "loading" }), [weekStart]);

  return { state, reload };
}
