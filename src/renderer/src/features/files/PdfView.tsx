import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Icon } from "../../shell/Icon";
import { PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { formatSize } from "./tree-view";
import { fitScale, locateCitation, mergeLineRects, PDF_PAGE_GAP, type PageRect } from "./pdf-view.ts";
import type { FileListRequest } from "@shared/files";
import type { PdfCitation } from "@shared/pdf-quote";

// pdf.js 的解析跑在 worker 里（大文档的解析不和 UI 抢主线程）。vite 把 worker 当静态
// 资源发出，dev 是 http、打包后是 file://——两种都由 pdf.js 自己起 module worker
GlobalWorkerOptions.workerSrc = workerUrl;

/** 一次跳转请求：引用 + 单调递增的 token（同一引用连点两次也要重新滚过去） */
export interface PdfJump {
  citation: PdfCitation;
  token: number;
}

type DocState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "too-large"; size: number; limit: number }
  | { status: "ready"; doc: PDFDocumentProxy; sizes: { width: number; height: number }[] };

/**
 * PDF 预览（实验功能「PDF 引用」）：逐页 canvas + pdf.js 文本层，适宽排版，只渲染
 * 视口附近的页（离开视口即释放 canvas——几百页的文档全渲出来会吃掉上 GB 内存）。
 *
 * 不用 pdfjs-dist 自带的 PDFViewer：它把文本层的条目↔DOM 映射（TextLayer.textDivs）
 * 关在私有字段里，而引用高亮恰恰要拿这张映射把归一化串上的区间落到 span 上。
 * 这里直接用 TextLayer，映射是公开的 getter。
 *
 * `jump` 变化（点了正文里的引用）：滚到那一页 → 等那页的文本层出来 → 定位原文、
 * 画高亮 → 把高亮滚到视口上部三分之一处。
 */
export function PdfView(props: { request: FileListRequest; jump: PdfJump | null; reloadToken: number }) {
  const t = useT();
  const { request, jump } = props;
  const [state, setState] = useState<DocState>({ status: "loading" });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
  /** 跳转未完成（等页渲染）时的 token；完成滚动后清空，后续的重渲染不再抢滚动条 */
  const pendingJumpRef = useRef<number | null>(null);
  const [missing, setMissing] = useState<number | null>(null);

  // 读字节 + 解析。换文件 / 刷新整份重来；卸载或被新请求顶掉时销毁旧文档（释放 worker 里的内存）
  useEffect(() => {
    let alive = true;
    let loading: ReturnType<typeof getDocument> | null = null;
    setState({ status: "loading" });
    void (async () => {
      try {
        const file = await api.files.readPdf(request);
        if (!alive) return;
        if (file.kind === "too-large") {
          setState({ status: "too-large", size: file.size, limit: file.limit });
          return;
        }
        loading = getDocument({ data: file.data });
        const doc = await loading.promise;
        const sizes: { width: number; height: number }[] = [];
        for (let number = 1; number <= doc.numPages; number++) {
          const viewport = (await doc.getPage(number)).getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
        }
        if (!alive) return;
        setState({ status: "ready", doc, sizes });
      } catch (cause: unknown) {
        if (!alive) return;
        const name = cause instanceof Error ? cause.name : "";
        setState({
          status: "error",
          message: name === "PasswordException" ? t.files.pdfPassword : `${t.files.pdfFailed} ${failMessage(cause)}`,
        });
      }
    })();
    return () => {
      alive = false;
      void loading?.destroy();
    };
    // request 每次渲染都是新对象：按它的字段判变化
  }, [request.sessionId, request.workspaceId, request.root, request.dir, props.reloadToken]);

  // 面板宽度变化（拖分栏、窄屏切换）→ 重算缩放
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (Math.abs(prev - next) >= 2 ? next : prev));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [state.status]);

  // 哪些页在视口附近（上下各多算一屏）：只有它们挂 canvas 与文本层
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null || state.status !== "ready") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const number = Number((entry.target as HTMLElement).dataset["page"]);
            if (entry.isIntersecting) next.add(number);
            else next.delete(number);
          }
          return next;
        });
      },
      { root, rootMargin: "100% 0px" },
    );
    for (const node of root.querySelectorAll<HTMLElement>(".pdf-page")) observer.observe(node);
    return () => observer.disconnect();
  }, [state, width]);

  // 新的跳转：先把目标页滚进视口（页还没渲染，高亮出来后再精调到原文处）。
  // **layout effect**：子组件的 passive effect 先于父组件跑——目标页已渲染时，它的高亮
  // 回调会抢在这里登记 pending 之前到达而被丢掉；layout effect 全部先于 passive effect
  useLayoutEffect(() => {
    if (jump === null || state.status !== "ready") return;
    pendingJumpRef.current = jump.token;
    setMissing(null);
    const node = scrollRef.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${jump.citation.page}"]`);
    node?.scrollIntoView({ block: "start" });
  }, [jump?.token, state.status]);

  if (state.status === "loading") {
    return (
      <div className="file-preview-loading">
        <Icon name="loader-circle" size={14} spin />
        {t.common.loading}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="file-preview-error">
        <PanelLine danger>{state.message}</PanelLine>
      </div>
    );
  }
  if (state.status === "too-large") {
    return (
      <div className="file-preview-error">
        <PanelLine>{t.files.tooLarge(formatSize(state.size), formatSize(state.limit))}</PanelLine>
      </div>
    );
  }

  const target = jump?.citation ?? null;
  return (
    <div className="pdf-view" ref={scrollRef}>
      {missing !== null && (
        <div className="pdf-view-notice">
          <PanelLine>{t.files.citeNotFound(missing)}</PanelLine>
        </div>
      )}
      {state.sizes.map((size, i) => {
        const number = i + 1;
        const scale = fitScale(width, size.width);
        return (
          <PdfPage
            key={number}
            doc={state.doc}
            number={number}
            scale={scale}
            width={size.width * scale}
            height={size.height * scale}
            active={visible.has(number) && width > 0}
            highlight={target !== null && target.page === number ? target : null}
            highlightToken={target !== null && target.page === number ? (jump?.token ?? null) : null}
            onHighlight={(rects) => {
              const token = pendingJumpRef.current;
              if (token === null || jump === null || token !== jump.token) return;
              pendingJumpRef.current = null;
              if (rects === null) {
                setMissing(number);
                return;
              }
              const first = rects[0];
              const scroller = scrollRef.current;
              const page = scroller?.querySelector<HTMLElement>(`.pdf-page[data-page="${number}"]`);
              if (first === undefined || scroller == null || page == null) return;
              // 高亮落到视口上部三分之一：上方留一点上下文，下方留出读完整段的空间
              scroller.scrollTop = page.offsetTop + first.top - scroller.clientHeight / 3;
            }}
          />
        );
      })}
    </div>
  );
}

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * 一页：固定尺寸的占位（滚动条长度从一开始就是对的），active 时挂 canvas 与文本层。
 * 高亮在文本层渲染完成后算：用 DOM Range 量出原文在各 span 里的矩形（span 被 pdf.js
 * 用 scaleX 拉到与 canvas 上的字形等宽，Range 的矩形已含变换），按行合并后画成覆盖层。
 */
function PdfPage(props: {
  doc: PDFDocumentProxy;
  number: number;
  scale: number;
  width: number;
  height: number;
  active: boolean;
  highlight: PdfCitation | null;
  /** 跳转 token：同一条引用再点一次，高亮要重新算一遍、重新回报（父组件据此再滚一次） */
  highlightToken: number | null;
  /** 高亮算完（null = 本页文本层里找不到这段） */
  onHighlight: (rects: PageRect[] | null) => void;
}) {
  const { doc, number, scale, active, highlight } = props;
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState<TextLayer | null>(null);
  const [rects, setRects] = useState<PageRect[]>([]);
  const onHighlightRef = useRef(props.onHighlight);
  onHighlightRef.current = props.onHighlight;

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const text = textRef.current;
    if (canvas === null || text === null) return;
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    let textLayer: TextLayer | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const task = page.render({
        canvas,
        viewport,
        ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
      });
      renderTask = task;
      text.replaceChildren();
      textLayer = new TextLayer({
        // 与 agent 侧 cite_pdf 同一组参数（shared/pdf-quote.ts 顶注释）
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: text,
        viewport,
      });
      await Promise.all([task.promise, textLayer.render()]);
      if (!cancelled) setLayer(textLayer);
    })().catch((cause: unknown) => {
      if (cause instanceof RenderingCancelledException || cancelled) return;
      // 单页渲染失败不掀翻整份预览：这一页留白，其余页照常
      console.error(`[pdf] 第 ${number} 页渲染失败`, cause);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      setLayer(null);
      setRects([]);
      // 释放位图：离开视口的页不该继续占着几 MB 的 canvas 内存
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [active, doc, number, scale]);

  useEffect(() => {
    if (layer === null || highlight === null) {
      setRects([]);
      return;
    }
    const page = pageRef.current;
    if (page === null) return;
    const span = locateCitation(layer.textContentItemsStr, highlight);
    if (span === null) {
      setRects([]);
      onHighlightRef.current(null);
      return;
    }
    const origin = page.getBoundingClientRect();
    const raw: PageRect[] = [];
    const range = document.createRange();
    for (let run = span.startRun; run <= span.endRun; run++) {
      const node = layer.textDivs[run]?.firstChild;
      // 空条目（hasText false）不进 DOM，没有文本节点
      if (node == null || node.nodeType !== Node.TEXT_NODE) continue;
      const length = node.textContent?.length ?? 0;
      range.setStart(node, run === span.startRun ? Math.min(span.startOffset, length) : 0);
      range.setEnd(node, run === span.endRun ? Math.min(span.endOffset, length) : length);
      for (const rect of range.getClientRects()) {
        raw.push({ left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height });
      }
    }
    const merged = mergeLineRects(raw);
    setRects(merged);
    onHighlightRef.current(merged.length > 0 ? merged : null);
  }, [layer, highlight, props.highlightToken]);

  return (
    <div
      ref={pageRef}
      className="pdf-page"
      data-page={number}
      style={{
        width: props.width,
        height: props.height,
        marginBottom: PDF_PAGE_GAP,
        // 文本层按这个系数排版（pdf.js 的 TextLayer 用 CSS 变量算字号与尺寸）
        "--total-scale-factor": String(scale),
      } as CSSProperties}
    >
      {active && (
        <>
          <canvas ref={canvasRef} className="pdf-page-canvas" />
          <div ref={textRef} className="textLayer" />
          {rects.map((rect, i) => (
            <div
              key={i}
              className="pdf-cite-mark"
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          ))}
        </>
      )}
    </div>
  );
}
