import { useEffect, useMemo, useState } from "react";
import type { MemoryHistoryEstimate, MemoryHistoryScope, MemoryHistoryStatus } from "@shared/memory";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import {
  defaultHistorySelection,
  historyActive,
  historyPercent,
  historyTotals,
  mergeHistoryScopes,
} from "./history-view.ts";

/**
 * 「从历史生成」：开关打开之前的聊天也整理成记忆（2026-10-30 用户：「得做！必须做」）。
 * 两种形态——
 * - 选范围：列出每个作用域的任务数，勾上的才统计「待处理 / 已处理 / 约几次模型调用」
 *   （要读转录，全量读太贵）；默认勾正在看的那个工作区；
 * - 进度：有任务（跑着 / 暂停 / 出错暂停）时常驻，可暂停 / 继续 / 停止。
 * 生成的条目照常出现在对应范围（memoryChanged 让列表自己刷新）。
 */
export function HistoryImport(props: { token: string; status: MemoryHistoryStatus | null; onClose: () => void }) {
  const { status } = props;
  // 上一次任务跑完 / 停了：先给结果，点「再选范围」才回到选择
  const [picking, setPicking] = useState(false);
  const finished = status !== null && (status.state === "done" || status.state === "stopped");
  if (status !== null && (historyActive(status) || (finished && !picking))) {
    return <HistoryProgress status={status} onClose={props.onClose} onAgain={() => setPicking(true)} />;
  }
  return <HistoryPicker token={props.token} onClose={props.onClose} />;
}

function HistoryPicker(props: { token: string; onClose: () => void }) {
  const t = useT();
  const [estimate, setEstimate] = useState<MemoryHistoryEstimate | null>(null);
  const [scopes, setScopes] = useState<MemoryHistoryScope[] | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 第一次：只列作用域（不读转录），按正在看的范围定默认勾选
  useEffect(() => {
    let live = true;
    api.memory
      .historyEstimate({ scopeIds: [] })
      .then((next) => {
        if (!live) return;
        setEstimate(next);
        setScopes(next.scopes);
        setSelected(new Set(defaultHistorySelection(next.scopes, props.token)));
      })
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      live = false;
    };
  }, [props.token]);

  // 勾选变了：统计还没算过的作用域（稍等一下，连点几个只算一次）
  const missing = useMemo(
    () => (scopes === null || selected === null ? [] : scopes.filter((scope) => selected.has(scope.scopeId) && scope.stats === null).map((scope) => scope.scopeId)),
    [scopes, selected],
  );
  useEffect(() => {
    if (missing.length === 0) return;
    let live = true;
    const timer = setTimeout(() => {
      api.memory
        .historyEstimate({ scopeIds: missing })
        .then((next) => {
          if (!live) return;
          setEstimate(next);
          setScopes((previous) => mergeHistoryScopes(previous, next.scopes));
        })
        .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [missing]);

  const toggle = (scopeId: string): void => {
    setSelected((previous) => {
      const next = new Set(previous ?? []);
      if (next.has(scopeId)) next.delete(scopeId);
      else next.add(scopeId);
      return next;
    });
  };

  const totals = scopes === null || selected === null ? null : historyTotals(scopes, selected);
  const chore = estimate?.chore ?? null;
  const canStart = totals !== null && !totals.counting && totals.turns > 0 && chore !== null && !busy;
  const start = async (): Promise<void> => {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.memory.historyStart({ scopeIds: [...selected] });
      if (next.state === "failed" && next.error !== undefined) setError(next.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const workspaces = (scopes ?? []).filter((scope) => scope.kind === "workspace");
  const folders = (scopes ?? []).filter((scope) => scope.kind === "cwd");
  const row = (scope: MemoryHistoryScope) => (
    <label key={scope.scopeId} className="mem-hist-row">
      <input type="checkbox" checked={selected?.has(scope.scopeId) ?? false} onChange={() => toggle(scope.scopeId)} />
      <span className="mem-hist-name" title={scope.name}>
        {scope.name}
      </span>
      <span className="mem-hist-meta row-trailing">
        {t.memory.historySessions(scope.sessions)}
        {selected?.has(scope.scopeId) === true && (
          <>
            {" · "}
            {scope.stats === null
              ? t.memory.historyCounting
              : t.memory.historyStats(scope.stats.turns, scope.stats.processed, scope.stats.calls)}
          </>
        )}
      </span>
    </label>
  );

  return (
    <div className="mem-form mem-hist">
      <span className="mem-form-title">{t.memory.historyTitle}</span>
      <p className="mem-page-hint">{t.memory.historyIntro}</p>
      {scopes === null ? (
        error === null && <p className="mem-page-hint">{t.common.loading}</p>
      ) : (
        <>
          {workspaces.length > 0 && (
            <div className="mem-hist-group">
              <span className="mem-hist-group-title">{t.memory.historyWorkspaces}</span>
              {workspaces.map(row)}
            </div>
          )}
          {folders.length > 0 && (
            <details className="mem-hist-group">
              <summary className="mem-hist-group-title">
                <Icon name="chevron-right" size={12} strokeWidth={1.8} />
                {t.memory.historyNoWorkspace}
              </summary>
              {folders.map(row)}
            </details>
          )}
        </>
      )}
      {totals !== null && totals.sessions > 0 && !totals.counting && (
        <span className="mem-status">{t.memory.historyTotal(totals.turns, totals.processed, totals.calls)}</span>
      )}
      {estimate !== null &&
        (chore === null ? (
          <span className="mem-status" data-tone="warn">
            <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
            {t.memory.historyNoChore}
          </span>
        ) : (
          <span className="mem-status">
            {t.memory.historyChore}
            <span className="mem-code">{chore.modelId}</span>
          </span>
        ))}
      {totals !== null && totals.sessions > 0 && !totals.counting && totals.turns === 0 && (
        <span className="mem-status">{t.memory.historyNothing}</span>
      )}
      <span className="mem-edit-row">
        <span className="mem-page-hint">{t.memory.historyResumeHint}</span>
        <span className="row-trailing mem-edit-row">
          <button type="button" className="mem-btn quiet" onClick={props.onClose}>
            {t.memory.cancel}
          </button>
          <button type="button" className="mem-btn primary" disabled={!canStart} onClick={() => void start()}>
            {busy ? <Icon name="loader-circle" size={12} spin /> : <Icon name="play" size={12} strokeWidth={1.8} />}
            {t.memory.historyStart}
          </button>
        </span>
      </span>
      {error !== null && <p className="mem-error">{t.memory.failed(error)}</p>}
    </div>
  );
}

function HistoryProgress(props: { status: MemoryHistoryStatus; onClose: () => void; onAgain: () => void }) {
  const t = useT();
  const { status } = props;
  const [busy, setBusy] = useState(false);
  const percent = historyPercent(status);
  const control = async (action: "pause" | "resume" | "stop"): Promise<void> => {
    setBusy(true);
    try {
      await api.memory.historyControl({ action });
    } finally {
      setBusy(false);
    }
  };
  const finished = status.state === "done" || status.state === "stopped";
  return (
    <div className="mem-form mem-hist" aria-live="polite">
      <span className="mem-hist-head">
        <span className="mem-form-title">{t.memory.historyTitle}</span>
        <span className="mem-status" data-tone={status.state === "failed" ? "warn" : undefined}>
          {status.state === "running" || status.state === "stopping" ? (
            <Icon name="loader-circle" size={13} spin />
          ) : status.state === "failed" ? (
            <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
          ) : finished ? (
            <Icon name="circle-check" size={13} strokeWidth={1.8} />
          ) : (
            <Icon name="pause" size={13} strokeWidth={1.8} />
          )}
          {t.memory.historyState(status.state)}
        </span>
        <span className="mem-hist-meta row-trailing">{t.memory.historyProgress(status.doneTurns, status.totalTurns)}</span>
      </span>
      <div className="mem-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <i style={{ width: `${percent}%` }} />
      </div>
      <span className="mem-hist-meta">
        {t.memory.historyEpisodes(status.episodes)}
        {" · "}
        {t.memory.historyWritten(status.written.fact, status.written.preference, status.written.insight)}
        {" · "}
        {t.memory.historyCalls(status.calls)}
      </span>
      {status.failed > 0 && (
        <span className="mem-status" data-tone="warn">
          <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
          {t.memory.historyFailedNote(status.failed)}
        </span>
      )}
      {status.error !== undefined && status.state === "failed" && <p className="mem-error">{status.error}</p>}
      <span className="mem-edit-row">
        <span className="mem-page-hint">{finished ? "" : t.memory.historyResumeHint}</span>
        <span className="row-trailing mem-edit-row">
          {finished ? (
            <>
              <button type="button" className="mem-btn quiet" onClick={props.onClose}>
                {t.memory.historyClose}
              </button>
              <button type="button" className="mem-btn" onClick={props.onAgain}>
                <Icon name="history" size={12} strokeWidth={1.8} />
                {t.memory.historyAgain}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="mem-btn quiet"
                disabled={busy || status.state === "stopping"}
                onClick={() => void control("stop")}
              >
                <Icon name="square" size={12} strokeWidth={1.8} />
                {t.memory.historyStop}
              </button>
              {status.state === "running" ? (
                <button type="button" className="mem-btn" disabled={busy} onClick={() => void control("pause")}>
                  <Icon name="pause" size={12} strokeWidth={1.8} />
                  {t.memory.historyPause}
                </button>
              ) : (
                <button
                  type="button"
                  className="mem-btn primary"
                  disabled={busy || status.state === "stopping"}
                  onClick={() => void control("resume")}
                >
                  <Icon name="play" size={12} strokeWidth={1.8} />
                  {t.memory.historyResume}
                </button>
              )}
            </>
          )}
        </span>
      </span>
    </div>
  );
}
