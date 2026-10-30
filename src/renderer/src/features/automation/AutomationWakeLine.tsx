import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { parseAutomationHeader } from "../../../../shared/automation.ts";
import "./automation.css";

/**
 * this_session 的任务到点把指令送回这条会话时，那一轮的 user 消息显示成一条细分隔线：
 * 「定时任务「…」第 3/12 次 · 10-31 01:45」。指令正文默认收着（简洁为默认，细节可展开），点一下看。
 * 认抬头不认别的——不是抬头的消息返回 null，调用方照常画用户气泡。
 */
export function parseWakeMessage(text: string): ReturnType<typeof parseAutomationHeader> {
  return parseAutomationHeader(text);
}

export function AutomationWakeLine(props: { title: string; number: number; max: number | null; stamp: string; body: string }) {
  const t = useT();
  const a = t.automation;
  const [open, setOpen] = useState(false);
  const label = a.wake(props.title, props.number, props.max, props.stamp);
  return (
    <div className="auto-wake" data-open={open}>
      <button
        type="button"
        className="auto-wake-head"
        aria-expanded={open}
        title={props.body === "" ? undefined : a.wakeExpand}
        disabled={props.body === ""}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="calendar-clock" size={12} strokeWidth={1.8} />
        <b>{label}</b>
        {props.body !== "" && <Icon name={open ? "chevron-down" : "chevron-right"} size={11} strokeWidth={2} />}
      </button>
      {open && props.body !== "" && <p className="auto-wake-body">{props.body}</p>}
    </div>
  );
}
