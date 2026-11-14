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
import { describeRow } from "./docx-review.ts";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";

export function DocxReviewBar(props: {
  rows: readonly DocxChangeRow[];
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
        {props.rows.map((row) => (
          <li key={row.key} className="docx-review-row" data-ours={row.ours ? "" : undefined}>
            <button
              type="button"
              className="docx-review-text"
              title={describeRow(row)}
              onClick={() => props.onLocate(row)}
            >
              <span className="docx-review-what">{describeRow(row)}</span>
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
        ))}
      </ul>
    </section>
  );
}
