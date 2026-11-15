/**
 * 引用在 PDF 用户空间里的位置（新阅读器的引用跳转用）：阅读器只认「第几页 + 一组 [x1, y1, x2, y2] 矩形」，
 * 而引用（cite_pdf）是在我们的 pdf.js（pdfjs-dist 6.1.200，与 agent 侧同版本）的文本条目上定位的。
 *
 * 做法与旧预览画高亮一模一样（PdfView.tsx 的 PdfPage）：在一个看不见的 scale 1 页面里排出 pdf.js 的文本层，
 * 用 locateCitation 找到条目区间，DOM Range 量出各段矩形、按行合并——只是最后把像素换回 PDF 用户空间
 * （scale 1 时 1px = 1pt，再由视口翻转 y 轴）。两份 pdf.js（阅读器自带的 5.x 改版 vs 我们的 6.1.200）
 * 对同一句话的落点差多少，见引入阅读器那次提交的说明。
 */
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../../api";
import { locateCitation, mergeLineRects, type PageRect } from "./pdf-view.ts";
import { pageRectToPdf } from "./pdf-reader-view.ts";
import type { FileListRequest } from "@shared/files";
import type { PdfCitation } from "@shared/pdf-quote";

// 与 PdfView.tsx 同一个 worker（模块各自设一次，谁先加载都成立）
GlobalWorkerOptions.workerSrc = workerUrl;

export interface ReaderCitePosition {
  pageIndex: number;
  rects: number[][];
}

/** 找不到（文件改过 / 页里没有这段）回 null；页面有旋转时也回 null（旋转页的坐标换算没做，交给调用方退回旧预览） */
export async function citeRectsForReader(request: FileListRequest, citation: PdfCitation): Promise<ReaderCitePosition | null> {
  const file = await api.files.readPdf(request);
  if (file.kind !== "pdf") return null;
  const loading = getDocument({ data: file.data });
  const host = document.createElement("div");
  try {
    const doc = await loading.promise;
    if (citation.page < 1 || citation.page > doc.numPages) return null;
    const page = await doc.getPage(citation.page);
    if (page.rotate % 360 !== 0) return null;
    const viewport = page.getViewport({ scale: 1 });
    // 看不见但参与排版：文本层要真排出来，Range 才量得到矩形。复用 .pdf-page 的文本层样式（styles.css）
    host.className = "pdf-page";
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
      visibility: "hidden",
      pointerEvents: "none",
    });
    host.style.setProperty("--total-scale-factor", "1");
    const text = document.createElement("div");
    text.className = "textLayer";
    host.append(text);
    document.body.append(host);
    const layer = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: text,
      viewport,
    });
    await layer.render();
    const span = locateCitation(layer.textContentItemsStr, citation);
    if (span === null) return null;
    const origin = host.getBoundingClientRect();
    const raw: PageRect[] = [];
    const range = document.createRange();
    for (let run = span.startRun; run <= span.endRun; run++) {
      const node = layer.textDivs[run]?.firstChild;
      if (node == null || node.nodeType !== Node.TEXT_NODE) continue;
      const length = node.textContent?.length ?? 0;
      range.setStart(node, run === span.startRun ? Math.min(span.startOffset, length) : 0);
      range.setEnd(node, run === span.endRun ? Math.min(span.endOffset, length) : length);
      for (const rect of range.getClientRects()) {
        raw.push({ left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height });
      }
    }
    const rects = mergeLineRects(raw).map((rect) => pageRectToPdf(rect, page.view));
    return rects.length > 0 ? { pageIndex: citation.page - 1, rects } : null;
  } finally {
    host.remove();
    void loading.destroy();
  }
}
