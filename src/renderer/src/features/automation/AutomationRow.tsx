import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { useT } from "../../locale.ts";
import type { Automation, AutomationAction } from "../../../../shared/automation.ts";
import { ROW_STATE_ICON, canRunNow, countLabel, noteOf, rowStateOf, subtitleOf } from "./automation-view.ts";

/**
 * 自动化面板里的一行：状态图标 + 标题 + 次数，第二行是调度人话与下次运行。单击整行进详情视图
 * （暂停 / 编辑 / 删除 / 运行记录都在那里）；悬停只浮出「立即运行」，次数给它让位。
 * 状态图标：运行中转圈 / 排期中 / 暂停 / 失败 / 已完成（整行弱化）。
 */
export function AutomationRow(props: {
  automation: Automation;
  now: number;
  /** 绑定会话的模式（this_session 且会话是 manual 档时提醒会卡在审批上）；其余 null */
  boundSession: { mode: string; title: string } | null;
  onOpen: () => void;
  onAct: (action: AutomationAction) => void;
}) {
  const t = useT();
  const a = t.automation;
  const { automation } = props;
  const state = rowStateOf(automation);
  const note = noteOf(automation, a, props.boundSession);
  const count = countLabel(automation, a);
  const runnable = canRunNow(automation);
  const where =
    automation.target.kind === "this_session"
      ? props.boundSession === null
        ? a.sentBackGone
        : a.sentBackTo(props.boundSession.title)
      : null;

  return (
    <div className="auto-item" data-state={state} data-runnable={runnable || undefined}>
      <button type="button" className="auto-row" aria-label={a.detail.openLabel(automation.title)} onClick={props.onOpen}>
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
      {runnable && (
        <span className="auto-acts">
          <IconButton
            label={a.actions.runNow}
            size={22}
            onClick={() => props.onAct({ type: "runNow" })}
            style={{ borderRadius: "var(--radius-sm)" }}
          >
            <Icon name="play" size={12} strokeWidth={2} />
          </IconButton>
        </span>
      )}
      {note !== null && (
        <p className="auto-note" data-tone={note.tone} role={note.tone === "danger" ? "alert" : undefined}>
          {note.text}
        </p>
      )}
    </div>
  );
}
