/**
 * PDF 选区批注（论文工作台，C1）：选中文字就出浮条「写意见 / 引用到对话」。
 *
 * - 写意见：批注带「选中文字 + 页码 + 页内坐标 + 意见」存项目目录 .orbita/annotations.json（原子写）；
 * - 引用到对话：复用会话的 quote（与 docx 选区 chip 同一套），不是另造概念；
 * - 侧边批注栏：与缩略图并列的另一个抽屉，列出本项目的批注。
 * 锚点用 quote + 页内坐标定位（重编后按 quote 找回）；SyncTeX 反查是可选增强（本机 TinyTeX 缺组件时降级）。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import type { LatexFileContext, PdfAnnotation } from "@shared/latex";

interface SelInfo {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
}

export function PdfAnnotations(props: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ctx: LatexFileContext | null;
  onQuote?: (text: string) => void;
}) {
  const [items, setItems] = useState<PdfAnnotation[]>([]);
  const [sel, setSel] = useState<SelInfo | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [comment, setComment] = useState("");
  const rangeRef = useRef<Range | null>(null);
  // 点「写意见 / 引用到对话」时选区会被浏览器清空：草稿打开期间不能跟着清 sel，
  // 否则「写意见」永远打不开草稿（C1 验收实测踩到）。
  const draftOpenRef = useRef(false);
  draftOpenRef.current = draftOpen;

  // 加载本项目的批注
  useEffect(() => {
    if (props.ctx === null) { setItems([]); return; }
    let cancelled = false;
    void api.latex.annotationsGet(props.ctx).then((store) => {
      if (!cancelled) setItems(store.annotations);
    });
    return () => { cancelled = true; };
  }, [props.ctx?.path]);

  // 选区监听：在 PDF 容器内选中 ≥2 个字符就出浮条
  useEffect(() => {
    const compute = () => {
      const container = props.containerRef.current;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) {
        if (!draftOpenRef.current) {
          setSel(null);
          rangeRef.current = null;
        }
        return;
      }
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) { setSel(null); return; }
      const text = selection.toString().trim();
      if (text.length < 2) { setSel(null); return; }
      const rect = range.getBoundingClientRect();
      const host = container.getBoundingClientRect();
      const pageEl = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer.closest(".pdf-page")
        : null;
      const page = pageEl ? Number(pageEl.getAttribute("data-page") ?? "1") : 1;
      rangeRef.current = range;
      setSel({ text, x: rect.x - host.x, y: rect.y - host.y, w: rect.width, h: rect.height, page });
    };
    document.addEventListener("selectionchange", compute);
    const container = props.containerRef.current;
    container?.addEventListener("scroll", compute);
    return () => {
      document.removeEventListener("selectionchange", compute);
      container?.removeEventListener("scroll", compute);
    };
  }, [props.containerRef]);

  const save = () => {
    if (!sel || !props.ctx || comment.trim() === "") return;
    const item: PdfAnnotation = {
      id: `a${Date.now().toString(36)}`,
      quote: sel.text,
      page: sel.page,
      rects: [{ x: sel.x, y: sel.y, w: sel.w, h: sel.h }],
      comment: comment.trim(),
      createdAt: Date.now(),
    };
    const next = [...items, item];
    setItems(next);
    void api.latex.annotationsPut({ ...props.ctx, store: { version: 1, annotations: next } });
    setComment("");
    setDraftOpen(false);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  const remove = (id: string) => {
    if (!props.ctx) return;
    const next = items.filter((a) => a.id !== id);
    setItems(next);
    void api.latex.annotationsPut({ ...props.ctx, store: { version: 1, annotations: next } });
  };

  return (
    <>
      {sel !== null && !draftOpen && (
        <div className="pdf-annot-float" style={{ left: sel.x, top: sel.y + sel.h + 8 }}>
          <button type="button" className="quiet-control" onClick={() => setDraftOpen(true)}>
            <Icon name="pencil-line" size={13} /> 写意见
          </button>
          <button type="button" className="quiet-control" onClick={() => props.onQuote?.(sel.text)}>
            <Icon name="plus" size={13} /> 引用到对话
          </button>
        </div>
      )}
      {draftOpen && sel !== null && (
        <div className="pdf-annot-draft" style={{ left: sel.x, top: sel.y + sel.h + 8 }}>
          <div className="annot-draft-quote">「{sel.text.slice(0, 60)}{sel.text.length > 60 ? "…" : ""}」</div>
          <textarea
            autoFocus
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="写一句意见（选中文字与页码会一起存）"
          />
          <div className="annot-draft-actions">
            <button type="button" className="quiet-control" disabled={comment.trim() === ""} onClick={save}>保存批注</button>
            <button type="button" className="quiet-control" onClick={() => setDraftOpen(false)}>取消</button>
          </div>
        </div>
      )}

      <div className="pdf-annot-rail" aria-label="批注">
        <div className="pdf-annot-rail-head">
          <Icon name="message-square" size={13} />
          <span>批注</span>
          <span className="row-trailing">{items.length}</span>
        </div>
        {items.length === 0 && (
          <div className="annot-empty">在 PDF 上选中一段文字，就能写意见或引用到对话。</div>
        )}
        {items.map((a) => (
          <div className="annot-card" key={a.id}>
            <div className="annot-comment">{a.comment}</div>
            <div className="annot-meta">「{a.quote.slice(0, 48)}{a.quote.length > 48 ? "…" : ""}」</div>
            <div className="annot-meta">第 {a.page} 页
              <button type="button" className="quiet-control annot-del" title="删除这条批注" onClick={() => remove(a.id)}>
                <Icon name="x" size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
