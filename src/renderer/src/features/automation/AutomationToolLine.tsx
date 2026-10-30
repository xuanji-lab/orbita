import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { useT } from "../../locale.ts";
import { EXIT_CARD_KICKER, EXIT_CARD_STYLE, ExitCard } from "../chat/ExitCard";
import { PanelButton } from "../../shell/RightPanel";
import { Icon } from "../../shell/Icon";
import { parseAutomationCard, type AutomationCardView } from "../../../../shared/automation.ts";
import { useAutomationUi } from "./automation-context.ts";
import { describeSchedule, formatWhen, rowStateOf } from "./automation-view.ts";
import "./automation.css";

/**
 * `automation_create` 的对话卡：标题、调度人话、去处、下次运行、已生效；
 * 按钮「在右栏查看」打开自动化面板并定位到它、「暂停」直接转移（暂停后变「继续」）。
 * 状态读**实时**的自动化列表（卡落定后它还会变：暂停了、跑满了、被取消了），列表里没有就退回结果里的快照，
 * 且说明「这条自动化已不存在」。结果帧还没到（running）时显示一行呼吸的创建中。
 *
 * 结果里的卡逐字段校验（parseAutomationCard），坏值当没有卡，退回通用工具行。
 */
export function automationCardOf(result: ToolTranscriptItem | undefined): AutomationCardView | null {
  if (result === undefined || result.status === "running" || result.status === "error") return null;
  const details: unknown = result.details;
  if (typeof details !== "object" || details === null) return null;
  return parseAutomationCard((details as Record<string, unknown>)["automation"]);
}

export function AutomationToolLine(props: { result: ToolTranscriptItem | undefined; interrupted: boolean }) {
  const t = useT();
  const a = t.automation;
  const ui = useAutomationUi();
  const card = automationCardOf(props.result);
  if (card === null) {
    return (
      <div style={EXIT_CARD_STYLE}>
        <span
          className={props.interrupted ? undefined : "orbita-breath"}
          style={{ ...EXIT_CARD_KICKER, color: props.interrupted ? "var(--color-text-tertiary)" : "var(--color-accent)" }}
        >
          {props.interrupted ? t.chat.toolInterrupted : a.title}
        </span>
      </div>
    );
  }
  const live = ui.automations.find((automation) => automation.id === card.id);
  const now = Date.now();
  const status = live === undefined ? card.status : live.status;
  const state = live === undefined ? status : rowStateOf(live);
  const nextRunAt = live === undefined ? card.nextRunAt : live.nextRunAt;
  const runCount = live === undefined ? card.runCount : live.runCount;
  const maxRuns = live === undefined ? card.maxRuns : live.maxRuns;
  const statusText =
    live === undefined && props.result !== undefined
      ? a.card.gone
      : state === "active"
        ? a.card.effective
        : a.state[state];
  const meta = [
    card.target === "this_session" ? a.card.thisSession : a.card.newSession,
    status === "active" && nextRunAt !== null ? a.card.next(formatWhen(nextRunAt, now, a)) : null,
    maxRuns !== undefined ? a.card.ends(runCount, maxRuns) : null,
    live?.until !== undefined ? a.card.endsUntil(formatWhen(live.until, now, a)) : card.until !== undefined ? a.card.endsUntil(formatWhen(card.until, now, a)) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const canToggle = live !== undefined && (live.status === "active" || live.status === "paused");
  return (
    <ExitCard
      kicker={a.title}
      icon="calendar-clock"
      title={card.title}
      status={{
        text: statusText,
        color: state === "failed" ? "var(--color-danger)" : state === "active" || state === "running" ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
        active: state === "running",
      }}
      preview={describeSchedule(live?.schedule ?? card.schedule, a, now)}
      meta={meta}
      actions={
        <>
          <PanelButton onClick={() => ui.openPanel(card.id)}>
            <Icon name="calendar-clock" size={14} /> {a.card.openPanel}
          </PanelButton>
          {canToggle && (
            <PanelButton onClick={() => void ui.act(card.id, { type: live.status === "active" ? "pause" : "resume" })}>
              <Icon name={live.status === "active" ? "pause" : "play"} size={14} />{" "}
              {live.status === "active" ? a.card.pause : a.card.resume}
            </PanelButton>
          )}
        </>
      }
    />
  );
}
