import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import type { ChannelMessageKind } from "@shared/channel";
import { channelKindIcon } from "./ChannelViews.tsx";
import type { HeldRow } from "./channel-hold.ts";
import { channelHold, useChannelHold, type HoldView } from "./channel-hold-store.ts";
import "./channel-hold.css";

/** 提示条里最多露几个子会话，其余收成「还有 N 个」 */
const ROWS_SHOWN = 4;

/**
 * 「N 个子会话交回了」提示条：子会话的回报先攒在这里，不替用户开一轮。
 *
 * 位置与配方跟排队条一致（输入框上方、浮起的玻璃卡、不拿 accent 染底），因为它也是
 * 「一件等着送出去的事」：排队条等的是用户自己的话，这条等的是子会话的回报。
 * 它本身就是「要不要现在讨论」的那句问——不让模型再开一轮去问，那等于又打岔一次。
 * 头一行：展开键 + 一句话（为什么先没送进来）+ 行尾两个动作；下面每个子会话一行。
 * 「稍后」把列表收起，头一行与 question 的红点仍在；question 新到会重新展开。
 */
export function ChannelHoldBar(props: { sessionId: string; titles: ReadonlyMap<string, string> }) {
  const t = useT();
  const view = useChannelHold(props.sessionId);
  if (view === null || view.held.length === 0) return null;
  const { summary, collapsed } = view;
  const shown = summary.rows.slice(0, ROWS_SHOWN);
  const hidden = summary.rows.length - shown.length;
  const reason = reasonOf(view, t);
  return (
    <section
      aria-label={t.channelHold.header(summary.children)}
      className="glass-card glass-float ch-bar"
      data-question={summary.hasQuestion || undefined}
    >
      <div className="ch-head">
        <button
          type="button"
          className="ch-fold"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t.channelHold.expand : t.channelHold.collapse}
          title={collapsed ? t.channelHold.expand : t.channelHold.collapse}
          onClick={() => channelHold.setCollapsed(props.sessionId, !collapsed)}
        >
          <span className="ch-lead">
            <Icon name={FEATURE_ICON.subsessions} size={14} />
            {summary.hasQuestion && <span className="ch-dot" aria-hidden="true" />}
          </span>
          <span className="ch-title">{t.channelHold.header(summary.children)}</span>
          {reason !== null && <span className="ch-reason">{reason}</span>}
        </button>
        <span className="row-trailing ch-actions">
          {!collapsed && (
            <button type="button" className="ch-btn" title={t.channelHold.laterTitle} onClick={() => channelHold.setCollapsed(props.sessionId, true)}>
              {t.channelHold.later}
            </button>
          )}
          <button type="button" className="ch-btn" data-primary="true" title={t.channelHold.discussTitle} onClick={() => channelHold.release(props.sessionId)}>
            {t.channelHold.discuss}
          </button>
        </span>
      </div>
      {collapsed && summary.hasQuestion && (
        <p className="ch-ask">{t.channelHold.questionBadge(summary.questions)}</p>
      )}
      {!collapsed && (
        <ul className="ch-list">
          {shown.map((row) => (
            <HeldRowView key={row.childId} row={row} title={props.titles.get(row.childId) ?? t.channelHold.untitled} t={t} />
          ))}
          {hidden > 0 && <li className="ch-more">{t.channelHold.more(hidden)}</li>}
        </ul>
      )}
    </section>
  );
}

function HeldRowView(props: { row: HeldRow; title: string; t: Messages }) {
  const { row, t } = props;
  const kindLabel = kindText(row.kind, t);
  return (
    <li className="ch-row" data-kind={row.kind}>
      <span className="ch-row-icon">
        <Icon name={channelKindIcon(row.kind)} size={12} />
      </span>
      <span className="ch-row-title" title={props.title}>
        {props.title}
      </span>
      <span className="ch-row-summary" title={row.summary}>
        {row.summary}
      </span>
      <span className="row-trailing ch-row-kind">
        {kindLabel}
        {row.count > 1 ? ` · ${t.channelHold.count(row.count)}` : ""}
      </span>
    </li>
  );
}

function kindText(kind: ChannelMessageKind, t: Messages): string {
  switch (kind) {
    case "question":
      return t.channelHold.kinds.question;
    case "done":
      return t.channelHold.kinds.done;
    case "failed":
      return t.channelHold.kinds.failed;
    case "progress":
      return t.channelHold.kinds.progress;
    default:
      return t.channelHold.kinds.other;
  }
}

/** 头一行里「为什么先没送进来」那半句：开关最先，其次读 / 写信号，再其次是重启留下的 */
function reasonOf(view: HoldView, t: Messages): string | null {
  if (view.holdOn) return t.channelHold.reasons.switch;
  if (view.reading !== null) return t.channelHold.reasons[view.reading];
  if (view.held.every((item) => item.recovered)) return t.channelHold.reasons.recovered;
  return null;
}
