import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { useT } from "../../locale.ts";
import { parseAutomationHeader } from "../../../../shared/automation.ts";
import { ExitCard } from "../chat/ExitCard";
import { useAutomationUi } from "./automation-context.ts";
import { firstLineOfWake, wakeAutomationId } from "./automation-view.ts";
import "./automation.css";

export function parseWakeMessage(text: string): ReturnType<typeof parseAutomationHeader> {
  return parseAutomationHeader(text);
}

/**
 * this_session 到点唤醒 = 一件从聊天区外送进来的事：和子会话交回同族的白卡，不再是细分隔线。
 * 第一行是任务与次数，第二行是指令首行与时间；全文默认收起。
 * 「看自动化」按**本会话 + 标题 + 指令**定位；历史任务已删或重名有歧义时只打开面板，不猜一条。
 */
export function AutomationWakeLine(props: {
  title: string;
  number: number;
  max: number | null;
  stamp: string;
  body: string;
  sessionId: string;
}) {
  const t = useT();
  const a = t.automation;
  const ui = useAutomationUi();
  const [open, setOpen] = useState(false);
  const automationId = wakeAutomationId(ui.automations, {
    sessionId: props.sessionId,
    title: props.title,
    body: props.body,
  });
  return (
    <div className="auto-wake" data-open={open}>
      <ExitCard
        className="auto-wake-card"
        kicker={a.wakeKicker}
        icon={FEATURE_ICON.automation}
        title={a.wakeTitle(props.title)}
        titleSuffix={<span className="exit-card-meta auto-wake-run">{a.wakeRun(props.number, props.max)}</span>}
        preview={firstLineOfWake(props.body)}
        meta={props.stamp}
        actions={
          <>
            {props.body !== "" && (
              <button
                type="button"
                className="card-btn auto-wake-expand"
                aria-expanded={open}
                aria-label={open ? a.wakeCollapse : a.wakeExpand}
                title={open ? a.wakeCollapse : a.wakeExpand}
                onClick={() => setOpen((value) => !value)}
              >
                <Icon name={open ? "chevron-down" : "chevron-right"} size={12} strokeWidth={1.8} />
              </button>
            )}
            <button type="button" className="card-btn" onClick={() => ui.openPanel(automationId)}>
              {a.wakeOpen}
            </button>
          </>
        }
        below={open && props.body !== "" ? <p className="auto-wake-body">{props.body}</p> : undefined}
      />
    </div>
  );
}
