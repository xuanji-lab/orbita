/**
 * 改动裁决的双 diff 对照（C2）：同一处改动，TeX 源码红绿 + 两版 PDF 并排。
 *
 * 打开时先把当前项目 PDF 备份成「改前」，重编得「改后」：
 * 左 = 改前 PDF（旧文本标红），右 = 改后 PDF（新文本标绿）。
 * 接受 = 改动留下；拒绝 = 现有按块撤销；评论 = 把意见带回 agent 下一轮。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { PdfView } from "./PdfView";
import type { EditorHunk } from "./editor-collab";
import type { LatexFileContext } from "@shared/latex";

export function PdfDiffReview(props: {
  hunk: EditorHunk;
  ctx: LatexFileContext;
  onAccept: () => void;
  onReject: () => void;
  onComment: (text: string) => void;
}) {
  const [backup, setBackup] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const backup = await api.latex.pdfBackup(props.ctx);
      if (cancelled) return;
      if (!backup.ok || backup.path == null) {
        setError(backup.error ?? "备份失败");
        return;
      }
      setBackup(backup.path);
      const outcome = await api.latex.compile(props.ctx);
      if (cancelled) return;
      if (outcome.ok === false) {
        setError(outcome.error ?? "重编失败");
        return;
      }
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [props.hunk.id, props.ctx]);

  const beforeSet = new Set(props.hunk.before);
  const afterSet = new Set(props.hunk.after);
  const oldText = props.hunk.before.filter((l) => !afterSet.has(l)).join("\n");
  const newText = props.hunk.after.filter((l) => !beforeSet.has(l)).join("\n");

  return (
    <div className="pdf-diff-review">
      <div className="diff-src">
        <div className="diff-title">TeX 源码（红 = 改前、绿 = 改后）</div>
        {props.hunk.before.map((line, i) => (
          <div key={`b${i}`} className={afterSet.has(line) ? "diff-ctx" : "diff-del"}>
            {afterSet.has(line) ? "  " : "− "}{line}
          </div>
        ))}
        {props.hunk.after.map((line, i) => (
          <div key={`a${i}`} className={beforeSet.has(line) ? "diff-ctx" : "diff-add"}>
            {beforeSet.has(line) ? "  " : "+ "}{line}
          </div>
        ))}
      </div>
      {error !== null ? (
        <div className="diff-error">{error}</div>
      ) : (
        <div className="diff-pdfs">
          <div className="diff-pdf-col">
            <div className="diff-title">改前 PDF（红）</div>
            {backup !== null && (
              <PdfView
                request={{ ...props.ctx, dir: backup }}
                jump={null}
                reloadToken={0}
                initialQuery={oldText}
                highlightTone="red"
              />
            )}
          </div>
          <div className="diff-pdf-col">
            <div className="diff-title">改后 PDF（绿）</div>
            {ready && (
              <PdfView
                request={{ ...props.ctx, dir: props.ctx.path }}
                jump={null}
                reloadToken={0}
                initialQuery={newText}
                highlightTone="green"
              />
            )}
          </div>
        </div>
      )}
      <div className="diff-actions">
        <button type="button" className="quiet-control diff-accept" onClick={props.onAccept}>接受</button>
        <button type="button" className="quiet-control diff-reject" onClick={props.onReject}>拒绝</button>
        <button type="button" className="quiet-control" onClick={() => props.onComment("这一处还没想好，先别动")}>评论</button>
      </div>
    </div>
  );
}
