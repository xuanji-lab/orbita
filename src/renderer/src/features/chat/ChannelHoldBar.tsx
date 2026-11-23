import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { channelHold, useChannelHold, type HoldView } from "./channel-hold-store.ts";
import "./channel-hold.css";

/**
 * 「N 个子会话交回了」——对话流里**只留这一行**，不在对话流里铺开内容。
 *
 * 内容（谁交回了什么、一句摘要）在右栏「子会话」面板的「待讨论」组里，那里可以看、可以回复
 * （用户 2026-11-23：子会话的内容不进主会话的对话流）。这一行只做两件事：告诉用户有几个交回了、
 * 有没有在等他回答；给两个出口——「在面板里看」与「现在讨论」（把攒着的合成一条投给主会话开一轮）。
 * 它本身就是那句「要不要现在讨论」：不让模型开一轮去问，那等于又打岔一次。
 *
 * 位置与外壳跟排队条一致（输入框上方、浮起的玻璃卡、不拿 accent 染底）。
 */
export function ChannelHoldBar(props: { sessionId: string; onOpenPanel?: () => void }) {
  const t = useT();
  const view = useChannelHold(props.sessionId);
  if (view === null || view.held.length === 0) return null;
  const { summary } = view;
  const note = noteOf(view, t);
  return (
    <section
      aria-label={t.channelHold.header(summary.children)}
      className="glass-card glass-float ch-bar"
      data-question={summary.hasQuestion || undefined}
    >
      <span className="ch-lead" title={summary.hasQuestion ? t.channelHold.askDot : undefined}>
        <Icon name={FEATURE_ICON.subsessions} size={14} />
        {summary.hasQuestion && <span className="ch-dot" aria-hidden="true" />}
      </span>
      <span className="ch-title">{t.channelHold.header(summary.children)}</span>
      {note !== null && <span className="ch-note">{note}</span>}
      <span className="row-trailing ch-actions">
        {props.onOpenPanel !== undefined && (
          <button type="button" className="ch-btn" title={t.channelHold.inPanelTitle} onClick={props.onOpenPanel}>
            {t.channelHold.inPanel}
          </button>
        )}
        <button
          type="button"
          className="ch-btn"
          data-primary="true"
          title={t.channelHold.discussTitle}
          onClick={() => channelHold.release(props.sessionId)}
        >
          {t.channelHold.discuss}
        </button>
      </span>
    </section>
  );
}

/** 标题后面那半句：有人在等回答最要紧；否则说「为什么先没送进来」（开关 > 读写信号 > 重启留下的） */
function noteOf(view: HoldView, t: Messages): string | null {
  if (view.summary.hasQuestion) return t.channelHold.withAsk(view.summary.questions);
  if (view.holdOn) return t.channelHold.reasons.switch;
  if (view.reading !== null) return t.channelHold.reasons[view.reading];
  if (view.held.every((item) => item.recovered)) return t.channelHold.reasons.recovered;
  return null;
}
