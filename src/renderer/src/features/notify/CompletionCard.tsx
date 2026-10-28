import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { visibleNoticeRows } from "./completion-notice.ts";

/** 卡片上的一行：一条刚跑完（或跑挂）的会话 */
export interface CompletionNoticeItem {
  id: string;
  /** 会话标题；空串按「新任务」占位显示 */
  title: string;
  /** 这一轮以失败收尾（重试耗尽等）：竖条红、行尾出错标记 */
  failed: boolean;
}

/**
 * 后台会话跑完的提醒卡（用户 2026-10-10）：在主槽（ChatView 那张卡）的右上角弹出，
 * 问用户这条结果怎么看——
 *
 * - 马上看：主槽换成这条会话（取代当前 ChatView）；
 * - 辅助对话：在右侧辅助对话里打开它，当前对话不动；
 * - 稍后（×）：收起卡片，侧栏那一行保持未读。
 *
 * **多条聚合**（用户 2026-10-25 裁决）：「多个任务完成，都要提醒才对」——同一拍有多条
 * 会话落定时只弹**一张**卡，把全部都列出来（失败的在前，同类刚完成的在上，行序由
 * completionNoticeItems 算好传进来），点某一行就在主槽打开它。单条时仍是原来那张紧凑
 * 两行卡（竖条 + 名字 + ×；下一行「打开 · 辅助对话」），外观与文案不变。
 * 行数有上限（NOTICE_VISIBLE_MAX）：其余收成一句「还有 N 条」，卡头的总数仍算全部。
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
  /** 同拍落定的会话（≥1 条，已按「失败在前、同类新的在上」排好） */
  items: readonly CompletionNoticeItem[];
  /** 主槽打开这条会话（单条卡是「打开」，多条的某一行也走这里） */
  onOpen: (id: string) => void;
  /** 在辅助对话里打开（只在单条卡上出现：当前对话不动） */
  onSideChat: (id: string) => void;
  /** 稍后：收起卡片，未读留在侧栏 */
  onLater: () => void;
}) {
  const t = useT();
  if (props.host === null) return null;
  const first = props.items[0];
  if (first === undefined) return null;
  const single = props.items.length === 1;
  const failedCount = props.items.filter((item) => item.failed).length;
  const summary = single
    ? first.failed
      ? t.notice.failed
      : t.notice.finished
    : failedCount === 0
      ? t.notice.manyFinished(props.items.length)
      : failedCount === props.items.length
        ? t.notice.manyFailed(failedCount)
        : t.notice.manyFinishedWithFailure(props.items.length, failedCount);
  const titleOf = (item: CompletionNoticeItem): string => (item.title === "" ? t.common.newTask : item.title);
  const { shown, more } = visibleNoticeRows(props.items);
  /** 单条卡沿用两行紧凑版：竖条 + 名字 + ×，下一行「打开 · 辅助对话」 */
  const singleBody = single ? (
    <>
      <div className="completion-card-row">
        <span className="status-bar" data-fill={first.failed ? "failed" : "done"} title={summary} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="completion-card-title" title={first.title}>
          {titleOf(first)}
        </span>
        <button
          type="button"
          className="quiet-control completion-card-close"
          aria-label={t.notice.later}
          title={t.notice.laterTip}
          onClick={props.onLater}
        >
          <Icon name="x" size={12} strokeWidth={2} />
        </button>
      </div>
      <div className="completion-card-actions">
        <button
          type="button"
          className="completion-card-link"
          data-primary
          title={t.notice.openNowTip}
          onClick={() => props.onOpen(first.id)}
        >
          {t.notice.openNow}
        </button>
        <span className="completion-card-dot" aria-hidden="true">·</span>
        <button type="button" className="completion-card-link" title={t.notice.sideChatTip} onClick={() => props.onSideChat(first.id)}>
          {t.notice.sideChat}
        </button>
      </div>
    </>
  ) : null;
  return createPortal(
    <div
      className={single ? "pane-pop completion-card" : "pane-pop completion-card completion-card-many"}
      role="status"
      aria-live="polite"
      aria-label={single ? `${summary}：${titleOf(first)}` : summary}
    >
      {single ? singleBody : (
        <>
          <div className="completion-card-head">{summary}</div>
          <div className="completion-card-list">
            {shown.map((item) => (
              // 整行就是一个「打开」：行序已排好（失败在前、新的在上），行尾出错标记
              // 是图标 + 文字（颜色只是第二信号）
              <button
                key={item.id}
                type="button"
                className="completion-card-item"
                title={item.title === "" ? t.common.newTask : `${titleOf(item)} · ${t.notice.openNowTip}`}
                onClick={() => props.onOpen(item.id)}
              >
                <span className="status-bar" data-fill={item.failed ? "failed" : "done"} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="completion-card-title">{titleOf(item)}</span>
                {item.failed && (
                  <span className="completion-card-flag">
                    <Icon name="triangle-alert" size={11} strokeWidth={2} />
                    {t.notice.failedFlag}
                  </span>
                )}
              </button>
            ))}
          </div>
          {more > 0 && (
            <div className="completion-card-more" title={t.notice.moreTip}>
              {t.notice.more(more)}
            </div>
          )}
          <div className="completion-card-actions">
            <button type="button" className="completion-card-link" title={t.notice.laterTip} onClick={props.onLater}>
              {t.notice.later}
            </button>
          </div>
        </>
      )}
    </div>,
    props.host,
  );
}
