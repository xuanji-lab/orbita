import { Icon } from "../Icon";
import { useT } from "../../locale";
import type { FocusSummary } from "./use-focus.ts";

/**
 * 时间到 / 提前结束后星云头顶的卡片（原型状态 9）：菜单面板配方（实底 + 发丝 +
 * --shadow-popover），尾巴对准星云（定位在 UsageMeter 的锚上）。内容四档：
 * ready = 3–5 条要点（模型原文）；running = 「正在整理」转圈行；failed / none =
 * 诚实的退路文案，不编造。按钮「结束专注」「再专注一轮」（沿用上次的时长与
 * 工作区，开回浮层）。
 */
export function FocusSummaryCard(props: {
  /** 卡片顶行的定性：时间到（自然跑满）或提前结束 */
  ending: boolean;
  minutes: number;
  workspaceName: string;
  summary: FocusSummary;
  onEnd: () => void;
  onAgain: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const body =
    props.summary.state === "ready" ? (
      <ul>
        {props.summary.bullets.map((bullet, index) => (
          <li key={index}>{bullet}</li>
        ))}
      </ul>
    ) : props.summary.state === "running" ? (
      <div className="neb-card-loading">
        <Icon name="loader-circle" size={14} spin />
        {t.focus.summaryRunning}
      </div>
    ) : props.summary.state === "failed" ? (
      <p className="neb-card-note" title={props.summary.message}>
        {t.focus.summaryFailed}
      </p>
    ) : props.summary.state === "none" ? (
      <p className="neb-card-note">
        {props.summary.reason === "no-model" ? t.focus.summaryNoModel : t.focus.summaryNoActivity}
      </p>
    ) : (
      <p className="neb-card-note">{t.focus.summaryRunning}</p>
    );

  const src =
    props.summary.state === "ready"
      ? t.focus.summarySource(props.summary.sessionsRead, props.summary.modelLabel)
      : null;

  return (
    <div className="neb-card menu-panel" role="dialog" aria-label={t.focus.cardLabel}>
      <div className="neb-card-kick">
        <Icon name="zap" size={12} strokeWidth={2} />
        {props.ending ? t.focus.cardKickEarly(props.minutes, props.workspaceName) : t.focus.cardKick(props.minutes, props.workspaceName)}
        <span className="neb-card-x">
          <button
            type="button"
            className="quiet-control neb-card-close"
            title={t.focus.cardClose}
            aria-label={t.focus.cardClose}
            onClick={props.onClose}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </div>
      <h4>{t.focus.cardTitle}</h4>
      {body}
      {src !== null && <div className="neb-card-src">{src}</div>}
      <div className="neb-card-acts">
        <button type="button" className="neb-card-btn" onClick={props.onEnd}>
          {t.focus.endFocus}
        </button>
        <button type="button" className="neb-card-btn" onClick={props.onAgain}>
          <Icon name="rotate-ccw" size={13} strokeWidth={2} />
          {t.focus.again}
        </button>
      </div>
    </div>
  );
}
