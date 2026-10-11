import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";

/**
 * 后台会话跑完的提醒卡（用户 2026-10-10）：在主槽（ChatView 那张卡）的右上角弹出，
 * 问用户这条结果怎么看——
 *
 * - 马上看：主槽换成这条会话（取代当前 ChatView）；
 * - 辅助对话：在右侧辅助对话里打开它，当前对话不动；
 * - 稍后：收起卡片，侧栏那一行保持未读底色。
 *
 * **层级**（用户 2026-10-10 第三轮）：它属于内容面（`.pane`）里的一层，不是挂在窗口上、
 * 骑在右栏与内容面之间的浮层——portal 进主槽的弹出宿主（`.pane-pop-host`），守
 * ChatView 的血线（styles.css 的 `.pane-pop`）；右栏面板开着时自然停在主槽这一侧。
 * 实色 `--color-bg-panel` + 发丝边 + popover 阴影：压在正文上，背后的字不能透出来。
 * **不抢焦点**：卡片弹出时用户多半正在别的会话里打字，自动聚焦会把
 * 正在输入的字吞掉；键盘用户 Tab 能走到它。
 */
export function CompletionCard(props: {
  /** 弹出宿主（主槽里的 `.pane-pop-host`）。null = 还没挂载，先不画 */
  host: HTMLElement | null;
  title: string;
  /** 这一轮以失败收尾（重试耗尽等）：kicker 换成出错的说法，图标换警示 */
  failed: boolean;
  onOpenNow: () => void;
  onSideChat: () => void;
  onLater: () => void;
}) {
  const t = useT();
  if (props.host === null) return null;
  return createPortal(
    <div
      className="pane-pop completion-card"
      role="status"
      aria-live="polite"
    >
      <div className="completion-card-kicker">
        <span
          className="completion-card-glyph"
          style={{ color: props.failed ? "var(--color-danger)" : "var(--color-accent)" }}
        >
          <Icon name={props.failed ? "triangle-alert" : "circle-check"} size={13} strokeWidth={1.8} />
        </span>
        <span>{props.failed ? t.notice.failed : t.notice.finished}</span>
      </div>
      <div className="completion-card-title" title={props.title}>
        {props.title === "" ? t.common.newTask : props.title}
      </div>
      <div className="completion-card-actions">
        <button type="button" className="btn-accent completion-card-btn" title={t.notice.openNowTip} onClick={props.onOpenNow}>
          {t.notice.openNow}
        </button>
        <button type="button" className="quiet-control completion-card-btn" title={t.notice.sideChatTip} onClick={props.onSideChat}>
          {t.notice.sideChat}
        </button>
        <button type="button" className="quiet-control completion-card-btn" title={t.notice.laterTip} onClick={props.onLater}>
          {t.notice.later}
        </button>
      </div>
    </div>,
    props.host,
  );
}
