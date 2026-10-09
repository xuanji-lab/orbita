import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";

/** 卡片右缘与锚点（辅助对话图标）左缘之间的空隙 */
const GAP = 8;
/** 卡片离窗口底边的最小留白：图标靠下时整张卡上移，不出窗 */
const EDGE = 8;

/**
 * 后台会话跑完的提醒卡（用户 2026-10-10）：钉在右图标条「辅助对话」图标的左侧，
 * 问用户这条结果怎么看——
 *
 * - 马上看：主槽换成这条会话（取代当前 ChatView）；
 * - 辅助对话：在右侧辅助对话里打开它，当前对话不动；
 * - 稍后：收起卡片，侧栏那一行保持未读底色。
 *
 * 浮在任意内容之上，所以走浮层配方（实色 `--color-bg-panel` + 发丝边 + popover 阴影，
 * 同 Menu）。**不抢焦点**：卡片弹出时用户多半正在别的会话里打字，自动聚焦会把
 * 正在输入的字吞掉；键盘用户 Tab 能走到它。
 */
export function CompletionCard(props: {
  /** 定位锚点：辅助对话图标。null = 还没挂载，先不画 */
  anchor: HTMLElement | null;
  title: string;
  /** 这一轮以失败收尾（重试耗尽等）：kicker 换成出错的说法，图标换警示 */
  failed: boolean;
  onOpenNow: () => void;
  onSideChat: () => void;
  onLater: () => void;
}) {
  const t = useT();
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const anchor = props.anchor;

  useLayoutEffect(() => {
    if (anchor === null) return;
    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      setPos({ top: rect.top, right: window.innerWidth - rect.left + GAP });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  if (anchor === null || pos === null) return null;
  return createPortal(
    <div
      className="completion-card"
      role="status"
      aria-live="polite"
      style={{ top: pos.top, right: pos.right, maxHeight: `calc(100vh - ${pos.top + EDGE}px)` }}
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
    document.body,
  );
}
