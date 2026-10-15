import { useContext, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { LocaleContext, useT } from "../../locale.ts";
import {
  MEMORY_BACKFILL_RANGES,
  type MemoryBackfillEstimate,
  type MemoryBackfillRange,
  type MemoryBackfillState,
  type MemoryBackfillStatus,
} from "@shared/memory";
import { backfillProgress, backfillView, tokenMagnitude } from "./memory-backfill.ts";

/**
 * 设置 › 记忆库 ›「从历史生成」：对已有聊天记录按轮补蒸记忆（用家务活模型）。
 *
 * 不做弹窗，做成记忆库头部下方的一块：
 * - 选范围（过去 1 / 3 / 6 个月 / 全部）→ 立刻给预估（会话数、待蒸轮数 = 调用次数、
 *   已蒸跳过数、token 量级、用哪个模型）→ 用户确认后才开始。代价先摆出来，再让人点。
 * - 跑起来后收成一条进度条，常驻在头部下方（翻作用域、搜索都不影响它），可暂停 /
 *   继续 / 停止；停止要第二段带文字的确认（停了已蒸的保留，但剩下的要重新开始）。
 * - 结束后留一句结果（新增几条、自动替换几条、失败几轮），可关掉；同时让库重拉。
 *
 * 状态以主进程为准：挂载时读一次，之后靠 memoryBackfillEvent 推送——关掉设置页再回来，
 * 或者重启应用后（主进程把跑到一半的任务恢复成暂停），看到的都是同一份进度。
 */
export function MemoryBackfill(props: {
  /** 头部按钮控制的「设置卡」开合 */
  setupOpen: boolean;
  onOpenSetup: () => void;
  onCloseSetup: () => void;
  /** 任务结束（完成 / 停止 / 失败）或暂停时调用——让记忆库重拉条目 */
  onSettled: () => void;
}) {
  const t = useT();
  const lang = useContext(LocaleContext);
  const [status, setStatus] = useState<MemoryBackfillStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [range, setRange] = useState<MemoryBackfillRange>("1m");
  const [estimate, setEstimate] = useState<
    { kind: "loading" } | { kind: "failed" } | { kind: "ready"; value: MemoryBackfillEstimate } | null
  >(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const previous = useRef<MemoryBackfillState | null>(null);
  const { onSettled } = props;

  useEffect(() => {
    let alive = true;
    void api.memory
      .backfillStatus()
      .then((value) => {
        if (alive) setStatus(value);
      })
      .catch(() => undefined);
    const off = api.memory.onBackfillEvent((value) => setStatus(value));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 库重拉的两个时机（跑着的时候不拉——进度条上已有计数，逐轮重拉整库太吵）：
  // ① 状态变了且新状态不是「在跑」（暂停 / 停止 / 完成 / 失败，含从暂停直接停止）；
  // ② 不在跑时新增条数又变了——暂停那一刻在飞的那批照常落盘，晚到的条目要补拉。
  // 落到结束态时把结果条重新亮出来。
  const newEntries = status?.newEntries ?? 0;
  const lastEntries = useRef(newEntries);
  useEffect(() => {
    const now = status?.state ?? null;
    const before = previous.current;
    previous.current = now;
    const grew = newEntries !== lastEntries.current;
    lastEntries.current = newEntries;
    if (now === null || now === "running") return;
    const changed = before !== null && before !== now;
    if (changed && now !== "paused") setDismissed(false);
    if (changed) setStopConfirm(false);
    if (changed || grew) onSettled();
  }, [status?.state, newEntries, onSettled]);

  // 设置卡开着时，按所选范围拉预估；切范围时丢掉过期的回执
  useEffect(() => {
    if (!props.setupOpen) return;
    let alive = true;
    setEstimate({ kind: "loading" });
    void api.memory.backfillEstimate(range).then(
      (value) => {
        if (alive) setEstimate({ kind: "ready", value });
      },
      () => {
        if (alive) setEstimate({ kind: "failed" });
      },
    );
    return () => {
      alive = false;
    };
  }, [props.setupOpen, range]);

  const view = backfillView(status, props.setupOpen, dismissed);
  if (view === "hidden") return null;

  const act = (action: () => Promise<MemoryBackfillStatus | void>): void => {
    setBusy(true);
    void action()
      .then((value) => {
        if (value) setStatus(value);
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const start = (): void => {
    setBusy(true);
    void api.memory
      .backfillStart(range)
      .then((result) => {
        setStatus(result.status);
        if (result.started) {
          setDismissed(false);
          props.onCloseSetup();
        }
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  if (view === "setup") {
    const ready = estimate?.kind === "ready" ? estimate.value : null;
    return (
      <section className="memlib-backfill" aria-label={t.memoryLib.backfillTitle}>
        <header className="memlib-backfill-head">
          <Icon name="history" size={13} strokeWidth={1.8} />
          <span className="memlib-backfill-title">{t.memoryLib.backfillTitle}</span>
          <button
            type="button"
            className="memlib-ib"
            title={t.memoryLib.backfillClose}
            aria-label={t.memoryLib.backfillClose}
            onClick={props.onCloseSetup}
          >
            <Icon name="x" size={13} strokeWidth={1.8} />
          </button>
        </header>
        <div className="memlib-backfill-ranges" role="radiogroup" aria-label={t.memoryLib.backfillRange}>
          {MEMORY_BACKFILL_RANGES.map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={range === choice}
              className="memlib-chip"
              aria-pressed={range === choice}
              onClick={() => setRange(choice)}
            >
              {rangeLabel(t, choice)}
            </button>
          ))}
        </div>
        <div className="memlib-backfill-estimate" aria-live="polite">
          {estimate === null || estimate.kind === "loading" ? (
            <span className="memlib-backfill-muted">
              <Icon name="loader-circle" size={12} spin />
              {t.memoryLib.backfillEstimating}
            </span>
          ) : estimate.kind === "failed" ? (
            <span className="memlib-row-error">{t.memoryLib.backfillEstimateFailed}</span>
          ) : ready !== null && ready.turns === 0 ? (
            <span className="memlib-backfill-muted">
              {t.memoryLib.backfillNothing}
              {ready.skippedTurns > 0 && ` · ${t.memoryLib.backfillSkipped(ready.skippedTurns)}`}
            </span>
          ) : ready !== null ? (
            <>
              <span>
                {t.memoryLib.backfillEstimate(ready.sessions, ready.turns, tokenMagnitude(ready.estimatedInputTokens, lang))}
              </span>
              <span className="memlib-backfill-muted">
                {ready.choreModel !== null
                  ? t.memoryLib.backfillModel(ready.choreModel.modelId)
                  : t.memoryLib.backfillModelFallback}
                {ready.skippedTurns > 0 && ` · ${t.memoryLib.backfillSkipped(ready.skippedTurns)}`}
              </span>
            </>
          ) : null}
          <span className="memlib-backfill-muted">{t.memoryLib.backfillNote}</span>
        </div>
        <div className="memlib-backfill-acts">
          <button
            type="button"
            className="mem-btn accent"
            disabled={busy || ready === null || ready.turns === 0}
            onClick={start}
          >
            {t.memoryLib.backfillStart}
          </button>
          <button type="button" className="mem-btn text" onClick={props.onCloseSetup}>
            {t.memoryLib.backfillClose}
          </button>
        </div>
      </section>
    );
  }

  // progress / result 共用一条条子
  if (status === null) return null;
  const pct = backfillProgress(status);
  if (view === "progress") {
    const paused = status.state === "paused";
    return (
      <div className="memlib-backfill-bar" role="status" aria-live="polite">
        <div
          className="memlib-backfill-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={status.totalTurns}
          aria-valuenow={status.doneTurns}
          data-paused={paused || undefined}
        >
          <span style={{ width: `${Math.round(pct * 1000) / 10}%` }} />
        </div>
        <div className="memlib-backfill-line">
          {paused ? (
            <Icon name="pause" size={12} strokeWidth={1.8} />
          ) : (
            <Icon name="loader-circle" size={12} spin />
          )}
          <span className="memlib-backfill-label">
            {paused
              ? t.memoryLib.backfillPausedLabel(status.doneTurns, status.totalTurns)
              : t.memoryLib.backfillRunning(status.doneSessions, status.totalSessions, status.doneTurns, status.totalTurns)}
          </span>
          <span className="memlib-backfill-muted">{t.memoryLib.backfillCounts(status.newEntries, status.replaced)}</span>
          <span className="memlib-backfill-acts">
            {stopConfirm ? (
              <>
                <button
                  type="button"
                  className="mem-btn danger solid"
                  disabled={busy}
                  onClick={() => act(() => api.memory.backfillCancel())}
                >
                  {t.memoryLib.backfillStopConfirm}
                </button>
                <button type="button" className="mem-btn text" onClick={() => setStopConfirm(false)}>
                  {t.memoryLib.actCancel}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="mem-btn"
                  disabled={busy}
                  onClick={() => act(() => (paused ? api.memory.backfillResume() : api.memory.backfillPause()))}
                >
                  <Icon name={paused ? "play" : "pause"} size={12} strokeWidth={1.8} />
                  {paused ? t.memoryLib.backfillResume : t.memoryLib.backfillPause}
                </button>
                <button type="button" className="mem-btn text danger" disabled={busy} onClick={() => setStopConfirm(true)}>
                  <Icon name="square" size={12} strokeWidth={1.8} />
                  {t.memoryLib.backfillStop}
                </button>
              </>
            )}
          </span>
        </div>
      </div>
    );
  }

  const failed = status.state === "failed";
  return (
    <div className="memlib-backfill-bar" role="status" data-state={status.state}>
      <div className="memlib-backfill-line">
        <Icon name={failed ? "triangle-alert" : "check"} size={12} strokeWidth={1.8} />
        <span className="memlib-backfill-label">
          {status.state === "done"
            ? t.memoryLib.backfillDone
            : status.state === "cancelled"
              ? t.memoryLib.backfillCancelled
              : t.memoryLib.backfillFailed}
        </span>
        <span className="memlib-backfill-muted">{t.memoryLib.backfillCounts(status.newEntries, status.replaced)}</span>
        {status.failedTurns > 0 && (
          <span className="memlib-backfill-muted">{t.memoryLib.backfillFailedTurns(status.failedTurns)}</span>
        )}
        <span className="memlib-backfill-acts">
          {status.state !== "done" && (
            <button type="button" className="mem-btn" onClick={props.onOpenSetup}>
              {t.memoryLib.backfillRetry}
            </button>
          )}
          <button type="button" className="mem-btn text" onClick={() => setDismissed(true)}>
            {t.memoryLib.backfillDismiss}
          </button>
        </span>
      </div>
      {failed && status.error !== undefined && <span className="memlib-row-error">{status.error}</span>}
    </div>
  );
}

function rangeLabel(t: ReturnType<typeof useT>, range: MemoryBackfillRange): string {
  if (range === "1m") return t.memoryLib.backfillRange1m;
  if (range === "3m") return t.memoryLib.backfillRange3m;
  if (range === "6m") return t.memoryLib.backfillRange6m;
  return t.memoryLib.backfillRangeAll;
}
