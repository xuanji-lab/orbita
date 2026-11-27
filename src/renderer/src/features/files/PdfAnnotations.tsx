/**
 * PDF 选区批注（论文工作台）：选中文字就出浮条「写意见 / 引用到对话」。
 *
 * - 写意见：批注带「选中文字 + 页码 + 页内坐标 + 意见」交给上层落盘（项目目录的
 *   .orbita/annotations.json，原子写）；
 * - 引用到对话：复用会话的 quote（与 docx 选区 chip 同一套），不是另造概念。
 *
 * **2026-11-27 用户裁决：列表是 PDF 右侧一条可开合的竖栏（与 tex 的「大纲」同一套形态）。**
 * 常驻 220px 侧栏在 1200 宽的论文工作台里吃掉 PDF 面板 47%（视口 245px、26% 缩放）；
 * 搬到底部横条又会被条数撑高、盖住 PDF。所以：工具栏一个键开合，竖栏宽
 * `min(240px, 55%)`，关掉时 PDF 拿回整块宽度。
 *
 * 这个组件负责**产生**批注：选区 → 浮条 → 草稿 → `onSave`；列表是下面的
 * `PdfAnnotationRail`（同一个文件：两者共用一份文案与行样式）。
 * 锚点用 quote + 页内坐标定位（重编后按 quote 找回）。
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import type { PdfAnnotation } from "@shared/latex";

interface SelInfo {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
}

/**
 * PDF 右侧批注栏（tex 大纲的同款形态：开关键在工具栏，竖着排，可关）。
 *
 * 一行一张卡：意见在上（要看的），引文与页码在下（定位用的注脚）。
 * 卡里不放按钮区——删除键钉在卡尾的 `row-trailing`，不占正文宽度。
 */
export function PdfAnnotationRail(props: {
  items: readonly PdfAnnotation[];
  onJump: (item: PdfAnnotation) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="pdf-annot-rail" aria-label={t.pdfAnnotations.title}>
      <div className="pdf-annot-rail-head">
        <Icon name="message-square" size={13} className="pdf-annot-rail-icon" />
        <span className="pdf-annot-rail-title">{t.pdfAnnotations.title}</span>
        <span className="pdf-annot-rail-count mono">{t.pdfAnnotations.countShort(props.items.length)}</span>
        <button
          type="button"
          className="quiet-control pdf-annot-rail-close"
          title={t.pdfAnnotations.closeTip}
          aria-label={t.pdfAnnotations.closeTip}
          onClick={props.onClose}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="pdf-annot-rail-list">
        {props.items.length === 0 && <p className="pdf-annot-rail-empty">{t.pdfAnnotations.empty}</p>}
        {props.items.map((item) => (
          <div className="pdf-annot-card" key={item.id}>
            <button
              type="button"
              className="pdf-annot-card-main"
              title={t.pdfAnnotations.locateTip}
              onClick={() => props.onJump(item)}
            >
              <span className="pdf-annot-card-comment">{item.comment}</span>
              <span className="pdf-annot-card-quote">
                「{item.quote.length > 80 ? `${item.quote.slice(0, 80)}…` : item.quote}」
              </span>
              <span className="pdf-annot-card-meta mono">{t.pdfAnnotations.page(item.page)}</span>
            </button>
            <button
              type="button"
              className="quiet-control pdf-annot-card-del"
              title={t.pdfAnnotations.deleteTip}
              aria-label={t.pdfAnnotations.deleteTip}
              onClick={() => props.onRemove(item.id)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PdfAnnotations(props: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 保存一条批注（上层写盘并更新抽屉里的列表） */
  onSave: (annotation: PdfAnnotation) => void;
  onQuote?: (text: string) => void;
}) {
  const t = useT();
  const [sel, setSel] = useState<SelInfo | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [comment, setComment] = useState("");
  const rangeRef = useRef<Range | null>(null);
  // 点「写意见 / 引用到对话」时选区会被浏览器清空：草稿打开期间不能跟着清 sel，
  // 否则「写意见」永远打不开草稿（C1 验收实测踩到）。
  const draftOpenRef = useRef(false);
  draftOpenRef.current = draftOpen;

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
      // 浮条与草稿是 .pdf-body 的绝对定位子元素（与滚动区 .pdf-view 同级）：坐标要按
      // .pdf-body 算。按滚动区算、又没有定位祖先时，浮条落到整块稿件区的左上——真机
      // 并排时它跑到了左边源码栏上（11-26 截图实测）
      const host = (container.parentElement ?? container).getBoundingClientRect();
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
    if (!sel || comment.trim() === "") return;
    props.onSave({
      id: `a${Date.now().toString(36)}`,
      quote: sel.text,
      page: sel.page,
      rects: [{ x: sel.x, y: sel.y, w: sel.w, h: sel.h }],
      comment: comment.trim(),
      createdAt: Date.now(),
    });
    setComment("");
    setDraftOpen(false);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <>
      {sel !== null && !draftOpen && (
        <div className="pdf-annot-float" style={{ left: sel.x, top: sel.y + sel.h + 8 }}>
          <button type="button" className="quiet-control" onClick={() => setDraftOpen(true)}>
            <Icon name="pencil-line" size={13} /> {t.pdfAnnotations.write}
          </button>
          <button type="button" className="quiet-control" onClick={() => props.onQuote?.(sel.text)}>
            <Icon name="plus" size={13} /> {t.pdfAnnotations.quote}
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
            placeholder={t.pdfAnnotations.placeholder}
          />
          <div className="annot-draft-actions">
            <button type="button" className="quiet-control" disabled={comment.trim() === ""} onClick={save}>
              {t.pdfAnnotations.save}
            </button>
            <button type="button" className="quiet-control" onClick={() => setDraftOpen(false)}>
              {t.common.cancel}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
