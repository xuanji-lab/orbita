import { useEffect, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { Menu, type MenuItem } from "../../shell/Menu";
import { PanelButton } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import type { Automation, AutomationAction } from "../../../../shared/automation.ts";
import {
  ROW_STATE_ICON,
  countLabel,
  formatTokens,
  noteOf,
  rowStateOf,
  runLine,
  runWhen,
  subtitleOf,
  visibleRuns,
} from "./automation-view.ts";

/**
 * 自动化面板里的一行：状态图标 + 标题 + 次数，第二行是调度人话与下次运行；悬停浮出「立即运行」与「更多」
 * （暂停 / 继续 / 重新启动 / 编辑 / 删除，删除二次确认）；点行展开运行记录，点一条记录在主区打开那次的会话。
 * 状态图标：运行中转圈 / 排期中 / 暂停 / 失败 / 已完成（整行弱化）。
 */
export function AutomationRow(props: {
  automation: Automation;
  now: number;
  /** 绑定会话的模式（this_session 且会话是 manual 档时提醒会卡在审批上）；其余 null */
  boundSession: { mode: string; title: string } | null;
  /** 跑出的会话还在不在（被用户删了的记录行不可点） */
  knownSessionIds: ReadonlySet<string>;
  open: boolean;
  focused: boolean;
  onToggle: () => void;
  onAct: (action: AutomationAction) => void;
  onEdit: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT();
  const a = t.automation;
  const { automation } = props;
  const state = rowStateOf(automation);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // 从对话卡「在右栏查看」跳来：滚进视野（只在被点名的那一刻）
  useEffect(() => {
    if (props.focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.focused]);

  const note = noteOf(automation, a, props.boundSession);
  const count = countLabel(automation, a);
  const canRunNow = (automation.status === "active" || automation.status === "paused") && state !== "running";
  const { shown, hidden } = visibleRuns(automation, showAllRuns);

  const items: MenuItem[] = [
    ...(automation.status === "active"
      ? [{ id: "pause", label: a.actions.pause, icon: "pause" as const, onSelect: () => props.onAct({ type: "pause" }) }]
      : automation.status === "paused"
        ? [{ id: "resume", label: a.actions.resume, icon: "play" as const, onSelect: () => props.onAct({ type: "resume" }) }]
        : [{ id: "restart", label: a.actions.restart, icon: "rotate-ccw" as const, onSelect: () => props.onAct({ type: "restart" }) }]),
    { id: "edit", label: a.actions.edit, icon: "pencil-line", onSelect: props.onEdit },
    { id: "delete", label: a.actions.delete, icon: "trash-2", danger: true, onSelect: () => setConfirmDelete(true) },
  ];

  const where =
    automation.target.kind === "this_session"
      ? props.boundSession === null
        ? a.sentBackGone
        : a.sentBackTo(props.boundSession.title)
      : null;

  return (
    <div
      ref={ref}
      className="auto-item"
      data-state={state}
      data-focus={props.focused || undefined}
      data-menu={menuOpen || undefined}
    >
      <button
        type="button"
        className="auto-row"
        aria-expanded={props.open}
        title={props.open ? a.collapseRuns : a.expandRuns}
        onClick={props.onToggle}
      >
        <span className="auto-ico">
          <Icon name={ROW_STATE_ICON[state]} size={14} strokeWidth={1.8} spin={state === "running"} />
        </span>
        <span className="auto-title">{automation.title}</span>
        <span className="auto-count row-trailing">{count}</span>
        <span className="auto-sub" title={where ?? undefined}>
          {subtitleOf(automation, props.now, a)}
          {where !== null ? ` · ${where}` : ""}
        </span>
      </button>
      <span className="auto-acts">
        <IconButton
          label={a.actions.runNow}
          size={22}
          disabled={!canRunNow}
          onClick={() => props.onAct({ type: "runNow" })}
          style={{ borderRadius: "var(--radius-sm)" }}
        >
          <Icon name="play" size={12} strokeWidth={2} />
        </IconButton>
        <Menu
          items={items}
          align="end"
          panelMinWidth={150}
          onOpenChange={setMenuOpen}
          trigger={({ open, toggle }) => (
            <IconButton
              label={a.actions.more}
              size={22}
              active={open}
              onClick={toggle}
              style={{ borderRadius: "var(--radius-sm)" }}
            >
              <Icon name="ellipsis-vertical" size={14} />
            </IconButton>
          )}
        />
      </span>
      {note !== null && (
        <p className="auto-note" data-tone={note.tone} role={note.tone === "danger" ? "alert" : undefined}>
          {note.text}
        </p>
      )}
      {confirmDelete && (
        <div className="auto-confirm" role="alertdialog" aria-label={a.actions.delete}>
          <span>{a.actions.deleteConfirm(automation.title)}</span>
          <div className="auto-confirm-actions">
            <PanelButton onClick={() => setConfirmDelete(false)}>{a.actions.cancel}</PanelButton>
            <PanelButton
              danger
              onClick={() => {
                setConfirmDelete(false);
                props.onAct({ type: "delete" });
              }}
            >
              {a.actions.deleteYes}
            </PanelButton>
          </div>
        </div>
      )}
      {props.open && (
        <div className="auto-runs">
          {automation.runs.length === 0 && <p className="auto-note">{a.runs.none}</p>}
          {shown.map((run) => {
            const line = runLine(run, a);
            const known = run.sessionId !== null && props.knownSessionIds.has(run.sessionId);
            return (
              <button
                key={run.id}
                type="button"
                className="auto-run"
                data-tone={line.tone}
                disabled={!known}
                title={known ? a.runs.open : run.sessionId === null ? a.runs.noSession : undefined}
                onClick={() => run.sessionId !== null && props.onOpenSession(run.sessionId)}
              >
                <Icon name={line.icon} size={12} strokeWidth={1.8} spin={run.status === "running"} />
                <span className="auto-run-when">{runWhen(run, props.now, a)}</span>
                <span className="auto-run-text">{line.text}</span>
                <span className="auto-run-tokens">{formatTokens(run.tokens)}</span>
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
    </div>
  );
}
