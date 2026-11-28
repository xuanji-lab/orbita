/**
 * 改动裁决的双 diff 对照（C2）：同一处改动，TeX 源码红绿 + 两版 PDF 并排。
 *
 * 打开时先把当前项目 PDF 备份成「改前」，重编得「改后」：
 * 左 = 改前 PDF（旧文本标红），右 = 改后 PDF（新文本标绿）。
 * 接受 = 改动留下；拒绝 = 现有按块撤销；评论 = 把意见带回 agent 下一轮。
 *
 * 文字全部走 `t`（`latex.diff` / 复用 `review` 的接受与拒绝）：这里是整块浮层，
 * 写死一句中文，英文界面里就整块只有中文。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../locale.ts";
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
  const t = useT();
  const [backup, setBackup] = useState<string | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * 错误只存「哪一步失败 + 引擎给的原话」，不存拼好的句子：这个 effect 只在换改动块时跑，
   * 而语言可以在面板开着的时候切——文案必须在渲染时取 `t`，否则会把挂载那一刻的
   * 语言冻在错误条里。
   */
  const [error, setError] = useState<{ step: "backupFailed" | "compileFailed"; detail: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    document.body.dataset.diffMount = "mounted";
    void (async () => {
      try {
        const backup = await api.latex.pdfBackup(props.ctx);
        if (cancelled) return;
        if (!backup.ok || backup.path == null) {
          setError({ step: "backupFailed", detail: backup.error ?? null });
          return;
        }
        setBackup(backup.path);
        document.body.dataset.diffStage = "backup-done";
        const outcome = await api.latex.compile(props.ctx);
        if (cancelled) return;
        if (outcome.ok === false) {
          setError({ step: "compileFailed", detail: outcome.error ?? null });
          return;
        }
        document.body.dataset.diffStage = "compile-done";
        // 改后视图要开的是**编译产物 PDF**，不是 main.tex（.tex 当 PDF 开会一直 loading）
        const project = await api.latex.project(props.ctx);
        if (project.found && project.project.pdf !== null) setPdfPath(project.project.pdf.path);
        setReady(true);
      } catch (cause) {
        if (!cancelled) setError({ step: "compileFailed", detail: String(cause) });
      }
    })();
    return () => {
      cancelled = true;
      document.body.dataset.diffMount = "unmounted";
    };
  }, [props.hunk.id, props.ctx.path]);

  const beforeSet = new Set(props.hunk.before);
  const afterSet = new Set(props.hunk.after);
  const oldText = props.hunk.before.filter((l) => !afterSet.has(l)).join("\n");
  const newText = props.hunk.after.filter((l) => !beforeSet.has(l)).join("\n");

  return (
    <div className="pdf-diff-review">
      <div className="diff-src">
        <div className="diff-title">{t.latex.diff.titleSrc}</div>
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
        <div className="diff-error">{error.detail ?? t.latex.diff[error.step]}</div>
      ) : (
        <div className="diff-pdfs">
          <div className="diff-pdf-col">
            <div className="diff-title">{t.latex.diff.titleBefore}</div>
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
            <div className="diff-title">{t.latex.diff.titleAfter}</div>
            {ready && pdfPath !== null && (
              <PdfView
                request={{ ...props.ctx, dir: pdfPath }}
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
        <button type="button" className="quiet-control diff-accept" onClick={props.onAccept}>
          {t.docx.reviewAccept}
        </button>
        <button type="button" className="quiet-control diff-reject" onClick={props.onReject}>
          {t.docx.reviewReject}
        </button>
        <button
          type="button"
          className="quiet-control"
          onClick={() => props.onComment(t.latex.diff.commentPreset)}
        >
          {t.latex.diff.comment}
        </button>
      </div>
    </div>
  );
}
