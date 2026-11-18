/**
 * 审阅条（N2）：**一行一条改动，整组裁决**。
 *
 * 为什么按组而不是按引擎的每条修订（`getTrackedChanges()`）：一次 replace 在 OOXML 里是
 * 删除侧 + 插入侧两个 `w:id`。只接受其中一个时干净视图的文本看起来没变，却残留半条修订
 * （实测），用户会以为按钮坏了。组由 `docx-review.ts` 从 `applied[].revisionIds` 折叠出来。
 *
 * 一行说三件事：改了什么（`describeRow`：A → B / + X / - Y）、谁改的（agent 写入 / 作者名）、
 * 以及这一组还在不在。点正文可以跳到那一处（引擎的 `scrollToAIEditOperation`）。
 *
 * 没有改动时整块不渲染——空审阅条是噪音。
 */
import type { DocxChangeRow } from "./docx-review.ts";
import { describeRow, reviewLineText } from "./docx-review.ts";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";

export function DocxReviewBar(props: {
  rows: readonly DocxChangeRow[];
  /** 块 id → 段号（1 起；0 / 缺省 = 不知道）。只给「文字太短、看不出位置」的行补上下文 */
  ordinals: ReadonlyMap<string, number>;
  busy: boolean;
  onResolve: (row: DocxChangeRow, decision: "accept" | "reject") => void;
  onAll: (decision: "accept" | "reject") => void;
  onLocate: (row: DocxChangeRow) => void;
}) {
  const t = useT();
  if (props.rows.length === 0) return null;
  return (
    <section className="docx-review" aria-label={t.docx.reviewTitle(props.rows.length)}>
      <div className="docx-review-head">
        <Icon name="pencil-line" size={13} />
        <span className="docx-review-title">{t.docx.reviewTitle(props.rows.length)}</span>
        <div className="docx-review-batch row-trailing">
          <button
            type="button"
            className="quiet-control docx-review-button"
            disabled={props.busy}
            onClick={() => props.onAll("accept")}
          >
            {t.docx.reviewAcceptAll}
          </button>
          <button
            type="button"
            className="quiet-control docx-review-button"
            disabled={props.busy}
            onClick={() => props.onAll("reject")}
          >
            {t.docx.reviewRejectAll}
          </button>
        </div>
      </div>
      <ul className="docx-review-list">
        {props.rows.map((row) => {
          const ordinal = row.blockId === null ? 0 : (props.ordinals.get(row.blockId) ?? 0);
          return (
          <li key={row.key} className="docx-review-row" data-ours={row.ours ? "" : undefined}>
            <button
              type="button"
              className="docx-review-text"
              title={describeRow(row, ordinal)}
              onClick={() => props.onLocate(row)}
            >
              {/* 改前 / 改后各一行（2026-11-15 验收 P0-3）：单行 `A → B` 在 375 的
                  面板里可用宽只有 221，省略号正好落在新文本的第一个字上——要判断的
                  恰是那半句。旧文删除线 + 新文下划线，形状是第一信号 */}
              {row.kind === "replace" ? (
                <span className="docx-review-pair">
                  <span className="docx-review-old">{reviewLineText(row.before)}</span>
                  <span className="docx-review-new">{reviewLineText(row.after)}</span>
                </span>
              ) : (
                <span className="docx-review-what">{describeRow(row, ordinal)}</span>
              )}
              <span className="docx-review-meta">
                {row.ours ? t.docx.reviewAgent : row.author === "" ? t.docx.reviewAgent : row.author}
                {row.reanchored ? ` · ${t.docx.reviewReanchored}` : ""}
              </span>
            </button>
            <div className="docx-review-verdict row-trailing">
              <button
                type="button"
                className="quiet-control docx-review-button"
                title={t.docx.reviewAccept}
                aria-label={t.docx.reviewAccept}
                disabled={props.busy}
                onClick={() => props.onResolve(row, "accept")}
              >
                <Icon name="check" size={12} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                className="quiet-control docx-review-button"
                title={t.docx.reviewReject}
                aria-label={t.docx.reviewReject}
                disabled={props.busy}
                onClick={() => props.onResolve(row, "reject")}
              >
                <Icon name="x" size={12} strokeWidth={2.2} />
              </button>
            </div>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
