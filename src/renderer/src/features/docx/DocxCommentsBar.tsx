/**
 * 批注条：**一行一条未解决的顶层批注**，点一行跳到它在正文里的锚点。
 *
 * 为什么不直接铺引擎自带的批注侧栏：我们关掉了 folio 的工具栏（`showToolbar=false`），
 * 批注栏的开关也在那条工具栏上，窄面板里它还会收成抽屉——入口等于没有。这里用与
 * 审阅条同一块区域、同一套行语言，把「谁 / 什么时候 / 说了什么」摆出来；回复与解决
 * 仍由引擎自己的批注卡负责（右键选中的文字 → 批注，或文档里已有的批注卡）。
 *
 * 锚点缺失（原文被删 / 批注没有 range）的行**不隐藏**：批注正文本身仍是信息，
 * 只是点不动，给一句「原文不在了」。做假跳转比不做更坏。
 */
import type { CommentRow } from "./docx-comments.ts";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";

export function DocxCommentsBar(props: {
  rows: readonly CommentRow[];
  onLocate: (row: CommentRow) => void;
}) {
  const t = useT();
  if (props.rows.length === 0) return null;
  return (
    <section className="docx-review docx-comments" aria-label={t.docx.commentsTitle(props.rows.length)}>
      <div className="docx-review-head">
        <Icon name="message-square" size={13} />
        <span className="docx-review-title">{t.docx.commentsTitle(props.rows.length)}</span>
      </div>
      <ul className="docx-review-list">
        {props.rows.map((row) => {
          const anchored = row.blockId !== null;
          return (
            <li key={row.id} className="docx-review-row">
              <button
                type="button"
                className="docx-review-text"
                title={anchored ? t.docx.commentLocate : t.docx.commentAnchorMissing}
                onClick={() => props.onLocate(row)}
                disabled={!anchored}
              >
                <span className="docx-review-what">{row.summary}</span>
                <span className="docx-review-meta">
                  {row.author}
                  {row.timeText === "" ? "" : ` · ${row.timeText}`}
                  {row.replyCount > 0 ? ` · ${t.docx.commentReplies(row.replyCount)}` : ""}
                  {anchored ? "" : ` · ${t.docx.commentAnchorMissing}`}
                </span>
              </button>
              <div className="docx-review-verdict row-trailing">
                <button
                  type="button"
                  className="quiet-control docx-review-button"
                  title={anchored ? t.docx.commentLocate : t.docx.commentAnchorMissing}
                  aria-label={anchored ? t.docx.commentLocate : t.docx.commentAnchorMissing}
                  disabled={!anchored}
                  onClick={() => props.onLocate(row)}
                >
                  <Icon name={anchored ? "corner-up-right" : "unlink"} size={12} strokeWidth={2.2} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
