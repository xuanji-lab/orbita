import { Icon } from "../Icon";
import { useT } from "../../locale";
import type { FocusSummary } from "./use-focus.ts";

/**
 * 时间到 / 提前结束后星云头顶的卡片（原型状态 9）：**portal 到 body + fixed**（侧栏
 * aside 是 overflow:hidden，360px 的卡在原地渲染右缘被裁——2026-10-19 用户截图实证），
 * 由 UsageMeter 的 NebCardPortal 锚在星云上方、尾巴对准云心。面板配方与 Menu 同一套
 * （glass-card glass-float menu-panel：实底 + 发丝 + 浮层阴影 + 圆角）。内容四档：
 * ready = 3–5 条要点（模型原文，自动换行）；running = 转圈行；failed = 一句诚实的
 * 退路 + **直接露在卡上的原因**（一行，超长截断，完整原文进 title）+ 重试键；
 * none = 诚实的退路文案。bullet 区可滚动（max-height 由锚限制在视口内），按钮行常驻可见。
 */
export function FocusSummaryCard(props: {
  /** 卡片顶行的定性：时间到（自然跑满）或提前结束 */
  ending: boolean;
  minutes: number;
  workspaceName: string;
  summary: FocusSummary;
  onRetry: () => void;
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
      <div>
        <p className="neb-card-note">{t.focus.summaryFailed}</p>
        {/* 原因就在卡上（不靠 hover）：一行，超长截断；完整原文仍进 title */}
        <p className="neb-card-reason" title={props.summary.message}>
          {props.summary.message}
        </p>
      </div>
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
    <div className="neb-card glass-card glass-float menu-panel" role="dialog" aria-label={t.focus.cardLabel}>
      <div className="neb-card-kick">
        <Icon name="zap" size={12} strokeWidth={2} />
        <span className="neb-card-kick-text">
          {props.ending
            ? t.focus.cardKickEarly(props.minutes, props.workspaceName)
            : t.focus.cardKick(props.minutes, props.workspaceName)}
        </span>
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
      {/* 内容区自己滚：卡高被锚限制在视口内，按钮行恒可见 */}
      <div className="neb-card-scroll">
        {body}
        {src !== null && <div className="neb-card-src">{src}</div>}
      </div>
      <div className="neb-card-acts">
        {props.summary.state === "failed" && (
          <button type="button" className="neb-card-btn" onClick={props.onRetry}>
            <Icon name="refresh-cw" size={13} strokeWidth={2} />
            {t.focus.summaryRetry}
          </button>
        )}
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
