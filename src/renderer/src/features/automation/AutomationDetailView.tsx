import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { Automation, AutomationAction, AutomationOutcome } from "../../../../shared/automation.ts";
import {
  countLabel,
  describeSchedule,
  detailActions,
  formatTokens,
  formatWhen,
  noteOf,
  promptIsLong,
  rowStateOf,
  runLine,
  runWhen,
  visibleRuns,
} from "./automation-view.ts";

const TOGGLE_ICON: Record<"pause" | "resume" | "restart", IconName> = {
  pause: "pause",
  resume: "play",
  restart: "rotate-ccw",
};

/**
 * 自动化详情（列表里单击一行进来）：标题 + 状态 + 一行副标题，一排动作（立即运行 / 暂停·继续·重新启动 / 删除），
 * 然后三张卡：做什么（指令原文）、什么时候 · 怎么跑（+ 改设置进编辑表单）、最近运行（点一条在主区打开那次会话）。
 * 删除就地确认：按钮那一行原地换成红底确认条，后果小字挂在下面。外框（标题栏 / 返回）由 AutomationPanel 给。
 */
export function AutomationDetailView(props: {
  automation: Automation;
  now: number;
  boundSession: { mode: string; title: string } | null;
  knownSessionIds: ReadonlySet<string>;
  act: (action: AutomationAction) => Promise<AutomationOutcome>;
  onEdit: () => void;
  onDeleted: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT();
  const a = t.automation;
  const d = a.detail;
  const { automation } = props;
  const state = rowStateOf(automation);
  const actions = detailActions(automation);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const run = async (action: AutomationAction): Promise<boolean> => {
    setBusy(true);
    const outcome = await props.act(action);
    setBusy(false);
    setError(outcome.ok ? null : outcome.error);
    return outcome.ok;
  };

  const where =
    automation.target.kind === "this_session"
      ? props.boundSession === null
        ? a.sentBackGone
        : a.sentBackTo(props.boundSession.title)
      : d.newSession;
  const schedule = describeSchedule(automation.schedule, a, props.now);
  const count = countLabel(automation, a);
  const subtitle = [schedule, where, count].filter((part) => part !== "").join(" · ");
  const when =
    (state === "active" || state === "running") && automation.schedule.kind !== "once"
      ? automation.nextRunAt === null
        ? schedule
        : `${schedule} · ${a.next(formatWhen(automation.nextRunAt, props.now, a))}`
      : schedule;
  const modeText =
    automation.target.kind === "this_session" ? d.modeFollow : automation.mode === "plan" ? d.modePlan : d.modeSkip;
  const modelText =
    automation.providerId !== undefined && automation.modelId !== undefined ? automation.modelId : null;
  const note = noteOf(automation, a, props.boundSession);
  const { shown, hidden } = visibleRuns(automation, showAllRuns);
  const long = promptIsLong(automation.prompt);

  return (
    <div className="auto-detail" data-state={state}>
      <header className="auto-dhead">
        <h2 className="auto-dtitle">{automation.title}</h2>
        <span className="auto-badge" data-state={state}>
          {a.state[state]}
        </span>
      </header>
      <p className="auto-dsub">{subtitle}</p>
      {note !== null && (
        <p className="auto-dnote" data-tone={note.tone} role={note.tone === "danger" ? "alert" : undefined}>
          {note.text}
        </p>
      )}

      {confirming ? (
        <div
          className="auto-ic"
          role="alertdialog"
          aria-label={d.deleteAsk(automation.title)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setConfirming(false);
            }
          }}
        >
          <div className="auto-ic-bar">
            <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
            <span className="auto-ic-ask">{d.deleteAsk(automation.title)}</span>
            <button
              type="button"
              className="auto-btn solid-danger"
              disabled={busy}
              onClick={() =>
                void run({ type: "delete" }).then((ok) => {
                  if (ok) props.onDeleted();
                })
              }
            >
              {a.actions.deleteYes}
            </button>
            <button type="button" className="auto-btn" ref={cancelRef} onClick={() => setConfirming(false)}>
              {a.actions.cancel}
            </button>
          </div>
          <p className="auto-ic-hint">{d.deleteHint}</p>
        </div>
      ) : (
        <div className="auto-dacts">
          {actions.runNow && (
            <button type="button" className="auto-btn" disabled={busy} onClick={() => void run({ type: "runNow" })}>
              <Icon name="play" size={14} strokeWidth={1.8} /> {a.actions.runNow}
            </button>
          )}
          <button type="button" className="auto-btn" disabled={busy} onClick={() => void run({ type: actions.toggle })}>
            <Icon name={TOGGLE_ICON[actions.toggle]} size={14} strokeWidth={1.8} /> {a.actions[actions.toggle]}
          </button>
          <button type="button" className="auto-btn danger auto-dacts-end" disabled={busy} onClick={() => setConfirming(true)}>
            <Icon name="trash-2" size={14} strokeWidth={1.8} /> {a.actions.delete}
          </button>
        </div>
      )}
      {error !== null && (
        <p className="auto-dnote" data-tone="danger" role="alert">
          {a.actionFailed(error)}
        </p>
      )}

      <section className="auto-card">
        <h3 className="auto-card-title">{d.what}</h3>
        <p className="auto-prompt" data-clamp={long && !promptOpen ? "true" : undefined}>
          {automation.prompt}
        </p>
        {long && (
          <button type="button" className="auto-linkbtn" onClick={() => setPromptOpen((value) => !value)}>
            {promptOpen ? d.showLess : d.showMore}
          </button>
        )}
      </section>

      <section className="auto-card">
        <h3 className="auto-card-title">{d.whenHow}</h3>
        <dl className="auto-facts">
          <dt>{d.time}</dt>
          <dd>{when}</dd>
          <dt>{d.where}</dt>
          <dd>{where}</dd>
          <dt>{d.mode}</dt>
          <dd>{modeText}</dd>
          {modelText !== null && (
            <>
              <dt>{d.model}</dt>
              <dd>{modelText}</dd>
            </>
          )}
          {automation.plugin !== undefined && (
            <>
              <dt>{d.plugin}</dt>
              <dd>{automation.plugin.name}</dd>
            </>
          )}
        </dl>
        <div className="auto-card-foot">
          <button type="button" className="auto-btn" onClick={props.onEdit}>
            <Icon name="pencil-line" size={14} strokeWidth={1.8} /> {d.editSettings}
          </button>
        </div>
      </section>

      <section className="auto-card">
        <h3 className="auto-card-title">{d.recent}</h3>
        {automation.runs.length === 0 ? (
          <p className="auto-dmute">{a.runs.none}</p>
        ) : (
          <div className="auto-runs auto-runs-flat">
            {shown.map((entry) => {
              const line = runLine(entry, a);
              const known = entry.sessionId !== null && props.knownSessionIds.has(entry.sessionId);
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="auto-run"
                  data-tone={line.tone}
                  disabled={!known}
                  title={known ? a.runs.open : entry.sessionId === null ? a.runs.noSession : undefined}
                  onClick={() => entry.sessionId !== null && props.onOpenSession(entry.sessionId)}
                >
                  <Icon name={line.icon} size={12} strokeWidth={1.8} spin={entry.status === "running"} />
                  <span className="auto-run-when">{runWhen(entry, props.now, a)}</span>
                  <span className="auto-run-text">{line.text}</span>
                  <span className="auto-run-tokens">{formatTokens(entry.tokens)}</span>
                </button>
              );
            })}
            {hidden > 0 && (
              <button type="button" className="auto-runs-more" onClick={() => setShowAllRuns(true)}>
                {a.runs.earlier(hidden)}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
