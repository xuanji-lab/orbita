import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
import {
  clampPercent,
  currentPageOf,
  DEFAULT_PDF_PREFS,
  fitPageScale,
  fitScale,
  firstMatchFrom,
  locateCitation,
  locateMatch,
  matchCounts,
  mergeLineRects,
  parsePdfPrefs,
  PDF_PAGE_GAP,
  PDF_PERCENT_MAX,
  PDF_PERCENT_MIN,
  PDF_PREFS_KEY,
  percentOfScale,
  scaleOfPercent,
  scrollTopForPage,
  searchIndex,
  serializePdfPrefs,
  stepMatch,
  stepPercent,
  type PageBox,
  type PageRect,
  type PdfViewPrefs,
  type PdfZoomMode,
} from "./pdf-view.ts";
import {
  indexPageText,
  sourceSpan,
  type PageTextIndex,
  type SourceSpan,
} from "../../../../shared/pdf-quote.ts";
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

/** 一次搜索的状态。`active` 是**全局**命中序号（-1 = 还没有选中的） */
interface FindState {
  /** 生效的查询（去抖之后；输入框里可能还在改） */
  query: string;
  /** 每页命中数，下标 = 页码 - 1 */
  counts: number[];
  active: number;
  /** 还在建语料 / 还在数 */
  busy: boolean;
  /** 文本抽取失败（坏页、加密页）：如实说，不假装「没有命中」 */
  failed: boolean;
}

const EMPTY_FIND: FindState = { query: "", counts: [], active: -1, busy: false, failed: false };

/** 搜索输入的防抖：每敲一个字就去抽全文是白烧 CPU */
const FIND_DEBOUNCE_MS = 300;

/** 缩略图宽度（px）。侧栏宽 136，留两侧内边距 */
const THUMB_WIDTH = 104;

/** 本地的预览偏好（localStorage）。读不出来就当没存过——偏好不值得让预览打不开 */
function readPrefs(): PdfViewPrefs {
  try {
    return parsePdfPrefs(window.localStorage.getItem(PDF_PREFS_KEY));
  } catch {
    // 存储不可用：默认档照常能读
    return { ...DEFAULT_PDF_PREFS };
  }
}

function writePrefs(prefs: PdfViewPrefs): void {
  try {
    window.localStorage.setItem(PDF_PREFS_KEY, serializePdfPrefs(prefs));
  } catch {
    // 存储不可用（隐私模式 / 配额满）：偏好记不住不是错误，本次会话照常生效
  }
}

/**
 * PDF 预览：逐页 canvas + pdf.js 文本层，只渲染视口附近（离开视口即释放 canvas）。
 *
 * 除了阅读本身，这一层还负责四件「长论文才会痛」的事，全部在同一个滚动几何上算：
 * 缩放（适宽 / 适页 / 50–400%，Ctrl+滚轮）、翻页（页码输入与上一页/下一页）、
 * 页内搜索（大小写与空白不敏感，命中高亮 + n/m）、缩略图侧栏。
 *
 * 不用 pdfjs-dist 自带的 PDFViewer：它把文本层的条目↔DOM 映射（TextLayer.textDivs）
 * 关在私有字段里，而引用高亮与搜索高亮恰恰要拿这张映射把区间落到 span 上。
 * 这里直接用 TextLayer，映射是公开的 getter。
 *
 * `jump` 变化（点了正文里的引用）：滚到那一页 → 等那页的文本层出来 → 定位原文、
 * 画高亮 → 把高亮滚到视口上部三分之一处。
 */
export function PdfView(props: { request: FileListRequest; jump: PdfJump | null; reloadToken: number }) {
  const t = useT();
  const { request, jump } = props;
  const [state, setState] = useState<DocState>({ status: "loading" });
  const [prefs, setPrefs] = useState<PdfViewPrefs>(readPrefs);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
  /** 跳转未完成（等页渲染）时的 token；完成滚动后清空，后续的重渲染不再抢滚动条 */
  const pendingJumpRef = useRef<number | null>(null);
  const [missing, setMissing] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  /** 页码输入框里正在编辑的内容；null = 没在编辑（显示当前页） */
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const pageRef = useRef(1);
  pageRef.current = page;
  const [findQuery, setFindQuery] = useState("");
  const [find, setFind] = useState<FindState>(EMPTY_FIND);
  /** 搜索语料（惰性建一次；换文件 / 重载时作废） */
  const corpusRef = useRef<PageTextIndex[] | null>(null);
  /** 当前命中的 token：rect 算完后按它精调滚动，旧 token 的回报丢掉 */
  const findTokenRef = useRef(0);
  const [findToken, setFindToken] = useState(0);

  const updatePrefs = (patch: Partial<PdfViewPrefs>): void => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      writePrefs(next);
      return next;
    });
  };

  // 读字节 + 解析。换文件 / 刷新整份重来；卸载或被新请求顶掉时销毁旧文档（释放 worker 里的内存）
  useEffect(() => {
    let alive = true;
    let loading: ReturnType<typeof getDocument> | null = null;
    setState({ status: "loading" });
    corpusRef.current = null;
    setFind(EMPTY_FIND);
    setFindQuery("");
    setPage(1);
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

  // 滚动层的可用尺寸（拖分栏、窄屏切换）→ 重算适宽 / 适页
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const measure = (): void => {
      setSize((prev) => {
        const next = { width: Math.floor(node.clientWidth), height: Math.floor(node.clientHeight) };
        return Math.abs(prev.width - next.width) < 2 && Math.abs(prev.height - next.height) < 2 ? prev : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [state.status]);

  /** 每一页的缩放比例：适宽逐页算（页宽可能不同），适页与自定义全篇同一个 */
  const scales = useMemo(() => {
    if (state.status !== "ready") return [];
    if (prefs.zoom === "custom") {
      const scale = scaleOfPercent(prefs.percent);
      return state.sizes.map(() => scale);
    }
    if (prefs.zoom === "fit-page") {
      const maxWidth = Math.max(...state.sizes.map((item) => item.width));
      const maxHeight = Math.max(...state.sizes.map((item) => item.height));
      const scale = fitPageScale(size.width, size.height, maxWidth, maxHeight);
      return state.sizes.map(() => scale);
    }
    return state.sizes.map((item) => fitScale(size.width, item.width));
  }, [state, size, prefs.zoom, prefs.percent]);

  /**
   * 各页在滚动内容里的真实位置（第一页顶端 = 0）。**读 DOM 而不是按缩放比例算**：
   * fit-width 的比例是逐页实数，页高乘出来带小数，累加八十多页就差出几十像素，
   * 跳页会落到上一页末尾（实测 88 → 87）。浏览器排完的 offsetTop 才是最终事实。
   */
  const measureBoxes = (): PageBox[] => {
    const scroller = scrollRef.current;
    if (scroller === null) return [];
    const nodes = [...scroller.querySelectorAll<HTMLElement>(".pdf-page")];
    const first = nodes[0];
    if (first === undefined) return [];
    const base = first.offsetTop;
    return nodes.map((node) => ({ top: node.offsetTop - base, height: node.offsetHeight }));
  };

  // 缩放 / 适页重排之后停在原来那一页：否则 Ctrl+滚轮一下就把人甩到别处
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = scrollTopForPage(measureBoxes(), pageRef.current);
    // 只跟着「页尺寸变了」走：state/size 变 → scales 变 → 重排完成
  }, [state, scales]);

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
  }, [state, scales]);

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

  /*
   * 搜索：输入去抖 → 建一次全文语料（惰性）→ 每页命中数 → 默认选中当前页之后的第一处。
   * 语料与页面文本层用的是同一组 getTextContent 选项（见 shared/pdf-quote.ts 顶注释），
   * 所以「计数」与「已渲染页上的高亮」不会各说各话。
   */
  useEffect(() => {
    const trimmed = findQuery.trim();
    if (state.status !== "ready" || trimmed === "") {
      setFind(EMPTY_FIND);
      return;
    }
    let alive = true;
    // 换查询先清空计数：新结果到达前不该拿着上一轮的 counts 决定「跳到哪一页」
    setFind({ query: trimmed, counts: [], active: -1, busy: true, failed: false });
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let corpus = corpusRef.current;
          if (corpus === null) {
            corpus = await buildSearchCorpus(state.doc);
            if (!alive) return;
            corpusRef.current = corpus;
          }
          const counts = matchCounts(corpus.map((index) => searchIndex(index, trimmed)));
          if (!alive) return;
          const active = firstMatchFrom(counts, pageRef.current);
          setFind({ query: trimmed, counts, active, busy: false, failed: false });
        } catch (cause) {
          if (!alive) return;
          console.error("[pdf] 搜索语料抽取失败", cause);
          setFind({ query: trimmed, counts: [], active: -1, busy: false, failed: true });
        }
      })();
    }, FIND_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [findQuery, state]);

  const totalMatches = find.counts.reduce((sum, count) => sum + count, 0);
  const activeMatch = locateMatch(find.counts, find.active);
  /** 当前命中在哪一页。**它是跳转的唯一依据**——只看 find.active 会在「新查询 + 旧计数」
   * 那一拍拿着上一轮的页码滚过去（真机：搜 Chapter 99 停在第 89 页，因为旧计数里
   * 唯一一处在第 89 页）；计数落定后 active 序号没变，那个 effect 也不会再跑。 */
  const activePage = activeMatch === null ? null : activeMatch.page;

  // 选中命中变化：跳到那一页，并把 token 交给页面——rect 算完后精调滚动
  useEffect(() => {
    if (activePage === null) return;
    scrollToPage(activePage);
    findTokenRef.current += 1;
    setFindToken(findTokenRef.current);
  }, [activePage, find.active]);

  const scrollToPage = (target: number): void => {
    const node = scrollRef.current;
    if (node === null) return;
    const boxes = measureBoxes();
    node.scrollTop = scrollTopForPage(boxes, target);
    setPage(Math.min(Math.max(1, target), Math.max(1, boxes.length)));
  };

  /**
   * 滚动时更新当前页。**不节流**：一次比较就是 121 次的数组扫描，比一个被浏览器
   * 节流/挂起的 rAF 可靠——窗口被遮挡时 rAF 可能整段时间不跑，而一旦「排队标记」
   * 卡在非零，之后的滚动就再也不更新页码（真机踩过：滚到第 88 页，输入框还停在 120）。
   */
  const onScroll = (): void => {
    const node = scrollRef.current;
    if (node === null) return;
    // 参考线在视口 1/4 处：搜索/引用把目标滚到上部三分之一，按上沿判会显示成上一页
    const next = currentPageOf(measureBoxes(), node.scrollTop, node.clientHeight * 0.25);
    setPage((current) => (current === next ? current : next));
  };

  /** 页码输入：回车 / 失焦提交，Esc 放弃；越界夹到 1..N（不弹错，夹一下最省事） */
  const commitPageDraft = (): void => {
    if (pageDraft === null) return;
    const typed = Number.parseInt(pageDraft, 10);
    setPageDraft(null);
    if (!Number.isFinite(typed)) return;
    scrollToPage(typed);
  };

  /** Ctrl+滚轮缩放（触控板捏合也是这条：wheel + ctrlKey）。锚点保持当前阅读位置 */
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      const base = prefs.zoom === "custom" ? prefs.percent : percentOfScale(scales[pageRef.current - 1] ?? 1);
      updatePrefs({ zoom: "custom", percent: stepPercent(base, direction) });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [prefs.zoom, prefs.percent, scales]);

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
  const totalPages = state.sizes.length;
  const zoomPercent =
    prefs.zoom === "custom" ? clampPercent(prefs.percent) : percentOfScale(scales[page - 1] ?? 1);

  /** n/m 导航：不再手算边界（stepMatch 已把折回与未选中两种情形定死） */
  const moveMatch = (direction: 1 | -1): void => {
    const total = find.counts.reduce((sum, count) => sum + count, 0);
    const next = stepMatch(find.active, total, direction);
    if (next !== find.active) setFind((current) => ({ ...current, active: next }));
  };

  /** 切回适宽 / 适页时把眼前实际比例记进 percent：再按 + 就是从现在的尺寸开始 */
  const setZoomMode = (zoom: PdfZoomMode): void => {
    updatePrefs({ zoom, percent: prefs.zoom === "custom" ? prefs.percent : zoomPercent });
  };


  return (
    <div className="pdf-shell">
      <div className="pdf-toolbar" role="toolbar" aria-label={t.files.pdfAria}>
        {/* 缩略图侧栏开合 */}
        <button
          type="button"
          className="quiet-control pdf-tool"
          aria-pressed={prefs.thumbnails}
          title={t.files.pdfThumbnails}
          aria-label={t.files.pdfThumbnails}
          onClick={() => updatePrefs({ thumbnails: !prefs.thumbnails })}
        >
          <Icon name="list" size={14} />
        </button>

        {/* 翻页 */}
        <div className="pdf-tool-group">
          <button
            type="button"
            className="quiet-control pdf-tool"
            title={t.files.pdfPrevPage}
            aria-label={t.files.pdfPrevPage}
            disabled={page <= 1}
            onClick={() => scrollToPage(page - 1)}
          >
            <Icon name="chevron-left" size={14} />
          </button>
          <input
            className="pdf-page-input"
            value={pageDraft ?? String(page)}
            aria-label={t.files.pdfPage(page, totalPages)}
            inputMode="numeric"
            onChange={(event) => setPageDraft(event.target.value)}
            onFocus={(event) => {
              setPageDraft(String(page));
              event.target.select();
            }}
            onBlur={commitPageDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPageDraft();
              else if (event.key === "Escape") setPageDraft(null);
            }}
          />
          <span className="pdf-page-total">/ {totalPages}</span>
          <button
            type="button"
            className="quiet-control pdf-tool"
            title={t.files.pdfNextPage}
            aria-label={t.files.pdfNextPage}
            disabled={page >= totalPages}
            onClick={() => scrollToPage(page + 1)}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </div>

        {/* 页内搜索 */}
        <div className="pdf-tool-group pdf-find">
          <Icon name="search" size={13} className="pdf-find-icon" />
          <input
            className="pdf-find-input"
            value={findQuery}
            placeholder={t.files.pdfFindPlaceholder}
            aria-label={t.files.pdfFindPlaceholder}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                moveMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                setFindQuery("");
              }
            }}
          />
          {find.busy ? (
            <Icon name="loader-circle" size={12} spin />
          ) : find.failed ? (
            <span className="pdf-find-count danger">{t.files.pdfFindFailed}</span>
          ) : find.query === "" ? null : totalMatches === 0 ? (
            <span className="pdf-find-count">{t.files.pdfFindNone}</span>
          ) : (
            <span className="pdf-find-count">
              {t.files.pdfFindCount((find.active < 0 ? 0 : find.active) + 1, totalMatches)}
            </span>
          )}
          {totalMatches > 0 && (
            <>
              <button
                type="button"
                className="quiet-control pdf-tool"
                title={t.files.pdfFindPrev}
                aria-label={t.files.pdfFindPrev}
                onClick={() => moveMatch(-1)}
              >
                <Icon name="chevron-up" size={13} />
              </button>
              <button
                type="button"
                className="quiet-control pdf-tool"
                title={t.files.pdfFindNext}
                aria-label={t.files.pdfFindNext}
                onClick={() => moveMatch(1)}
              >
                <Icon name="chevron-down" size={13} />
              </button>
            </>
          )}
        </div>

        {/* 缩放：± 与适宽 / 适页。百分比永远显示「真正画出来的比例」 */}
        <div className="pdf-tool-group pdf-zoom">
          <button
            type="button"
            className="quiet-control pdf-tool"
            title={t.files.pdfZoomOut}
            aria-label={t.files.pdfZoomOut}
            disabled={prefs.zoom === "custom" && prefs.percent <= PDF_PERCENT_MIN}
            onClick={() => updatePrefs({ zoom: "custom", percent: stepPercent(zoomPercent, -1) })}
          >
            <Icon name="zoom-out" size={14} />
          </button>
          <span className="pdf-zoom-percent">{zoomPercent}%</span>
          <button
            type="button"
            className="quiet-control pdf-tool"
            title={t.files.pdfZoomIn}
            aria-label={t.files.pdfZoomIn}
            disabled={prefs.zoom === "custom" && prefs.percent >= PDF_PERCENT_MAX}
            onClick={() => updatePrefs({ zoom: "custom", percent: stepPercent(zoomPercent, 1) })}
          >
            <Icon name="zoom-in" size={14} />
          </button>
          <button
            type="button"
            className="quiet-control pdf-tool"
            aria-pressed={prefs.zoom === "fit-width"}
            title={t.files.pdfFitWidth}
            aria-label={t.files.pdfFitWidth}
            onClick={() => setZoomMode("fit-width")}
          >
            <Icon name="maximize" size={14} />
          </button>
          <button
            type="button"
            className="quiet-control pdf-tool"
            aria-pressed={prefs.zoom === "fit-page"}
            title={t.files.pdfFitPage}
            aria-label={t.files.pdfFitPage}
            onClick={() => setZoomMode("fit-page")}
          >
            <Icon name="file" size={14} />
          </button>
        </div>
      </div>

      <div className="pdf-body">
        {prefs.thumbnails && (
          <PdfThumbnails
            doc={state.doc}
            sizes={state.sizes}
            current={page}
            label={t.files.pdfThumbnails}
            onSelect={(target) => scrollToPage(target)}
          />
        )}

        <div className="pdf-view" ref={scrollRef} onScroll={onScroll}>
          {missing !== null && (
            <div className="pdf-view-notice">
              <PanelLine>{t.files.citeNotFound(missing)}</PanelLine>
            </div>
          )}
          {state.sizes.map((item, i) => {
            const number = i + 1;
            const scale = scales[i] ?? 1;
            const activeMatchOnPage =
              activeMatch !== null && activeMatch.page === number ? activeMatch.ordinal : null;
            return (
              <PdfPage
                key={number}
                doc={state.doc}
                number={number}
                scale={scale}
                width={item.width * scale}
                height={item.height * scale}
                active={visible.has(number) && size.width > 0}
                highlight={target !== null && target.page === number ? target : null}
                highlightToken={target !== null && target.page === number ? (jump?.token ?? null) : null}
                findQuery={find.query}
                findOrdinal={activeMatchOnPage}
                findToken={findToken}
                onFindRect={(token, rect) => {
                  if (token !== findTokenRef.current || activeMatch === null) return;
                  const scroller = scrollRef.current;
                  const pageNode = scroller?.querySelector<HTMLElement>(`.pdf-page[data-page="${activeMatch.page}"]`);
                  if (scroller == null || pageNode == null) return;
                  if (rect === null) {
                    // 文本层里找不到这一处（语料与页面内容不同步）：留在页顶，不猜位置
                    scroller.scrollTop = scrollTopForPage(measureBoxes(), activeMatch.page);
                    return;
                  }
                  scrollPageRectIntoView(scroller, pageNode, rect);
                }}
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
                  scrollPageRectIntoView(scroller, page, first);
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );

}

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 全文语料：每页一份索引。只在第一次搜索时建，之后换查询只重数不重建 */
async function buildSearchCorpus(doc: PDFDocumentProxy): Promise<PageTextIndex[]> {
  const out: PageTextIndex[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    // 与 TextLayer 同一组选项（shared/pdf-quote.ts 顶注释）：不开 normalization，
    // 条目串与渲染出来的 span 一一对应
    const content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    const items = content.items.flatMap((item) => ("str" in item ? [item.str] : []));
    out.push(indexPageText(items.map((str) => ({ str }))));
  }
  return out;
}

/**
 * 把页内的一块矩形滚到视口上部三分之一。**用 getBoundingClientRect 的差值算**：
 * `page.offsetTop` 是相对最近的定位祖先（这里是 .files-panel-layout），不是滚动层，
 * 直接拿它当 scrollTop 会差掉工具栏与页头那一截。
 */
function scrollPageRectIntoView(
  scroller: HTMLElement,
  page: HTMLElement,
  rect: { top: number },
): void {
  const pageTop = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = pageTop + rect.top - scroller.clientHeight / 3;
}

/** 文本层上的一段源区间 → 页面内的矩形（按行合并）。引用高亮与搜索高亮共用 */
function rectsForSpan(layer: TextLayer, page: HTMLElement, span: SourceSpan): PageRect[] {
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
  return mergeLineRects(raw);
}

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
  /** 生效的搜索查询（空 = 没在搜）。本页的命中按自己的文本层重搜，与计数同参数 */
  findQuery: string;
  /** 本页上「当前那一处」的序号（0 基）；不在本页 / 没有选中时为 null */
  findOrdinal: number | null;
  findToken: number;
  /** 当前命中的矩形算完（null = 本页文本层里找不到）；token 用来丢掉旧回报 */
  onFindRect: (token: number, rect: PageRect | null) => void;
  /** 高亮算完（null = 本页文本层里找不到这段） */
  onHighlight: (rects: { left: number; top: number; width: number; height: number }[] | null) => void;
}) {
  const { doc, number, scale, active, highlight, findQuery } = props;
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState<TextLayer | null>(null);
  const [rects, setRects] = useState<PageRect[]>([]);
  const [findRects, setFindRects] = useState<{ rect: PageRect; active: boolean }[]>([]);
  const onHighlightRef = useRef(props.onHighlight);
  onHighlightRef.current = props.onHighlight;
  const onFindRectRef = useRef(props.onFindRect);
  onFindRectRef.current = props.onFindRect;

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
      setFindRects([]);
      // 释放位图：离开视口的页不该继续占着几 MB 的 canvas 内存
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [active, doc, number, scale]);

  // 引用高亮
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
    const merged = rectsForSpan(layer, page, span);
    setRects(merged);
    onHighlightRef.current(merged.length > 0 ? merged : null);
  }, [layer, highlight, props.highlightToken]);

  // 搜索高亮：本页所有命中都画，当前那一处颜色更重
  useEffect(() => {
    const page = pageRef.current;
    if (layer === null || findQuery === "" || page === null) {
      setFindRects([]);
      if (findQuery === "") return;
      return;
    }
    // 本页只建一次索引：计数与高亮用同一把尺子，也省掉重复的归一化
    const index = indexPageText(layer.textContentItemsStr.map((str) => ({ str })));
    const matches = searchIndex(index, findQuery);
    const painted: { rect: PageRect; active: boolean }[] = [];
    let activeRect: PageRect | null = null;
    matches.forEach((match, ordinal) => {
      const span = sourceSpan(index, match.start, match.end);
      if (span === null) return;
      const merged = rectsForSpan(layer, page, span);
      const isActive = props.findOrdinal === ordinal;
      if (isActive) activeRect = merged[0] ?? null;
      for (const rect of merged) painted.push({ rect, active: isActive });
    });
    setFindRects(painted);
    if (props.findOrdinal !== null) onFindRectRef.current(props.findToken, activeRect);
  }, [layer, findQuery, props.findOrdinal, props.findToken]);

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
          {findRects.map((mark, i) => (
            <div
              key={`find-${i}`}
              className={`pdf-find-mark${mark.active ? " active" : ""}`}
              style={{
                left: mark.rect.left,
                top: mark.rect.top,
                width: mark.rect.width,
                height: mark.rect.height,
              }}
            />
          ))}
          {rects.map((rect, i) => (
            <div
              key={`cite-${i}`}
              className="pdf-cite-mark"
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * 缩略图侧栏：每页一张小 canvas，按侧栏内的可见性懒渲染（100 页的文档不能一开
 * 就画 100 张位图）。点击滚到那一页；当前页有 accent 描边。
 */
function PdfThumbnails(props: {
  doc: PDFDocumentProxy;
  sizes: { width: number; height: number }[];
  current: number;
  label: string;
  onSelect: (page: number) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    const root = listRef.current;
    if (root === null) return;
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
      { root, rootMargin: "200% 0px" },
    );
    for (const node of root.querySelectorAll<HTMLElement>(".pdf-thumb")) observer.observe(node);
    return () => observer.disconnect();
  }, [props.doc]);

  // 当前页滚到侧栏可见处（翻页之后缩略图跟着走）
  useEffect(() => {
    const list = listRef.current;
    const node = list?.querySelector<HTMLElement>(`.pdf-thumb[data-page="${props.current}"]`);
    if (list == null || node == null) return;
    // 自己算滚动量而不是 scrollIntoView：后者会把面板外层也一起滚一段
    const top = node.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + node.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + node.offsetHeight - list.clientHeight;
    }
  }, [props.current]);

  return (
    <div className="pdf-thumbs" ref={listRef} aria-label={props.label}>
      {props.sizes.map((size, i) => {
        const number = i + 1;
        return (
          <PdfThumb
            key={number}
            doc={props.doc}
            number={number}
            width={size.width}
            height={size.height}
            active={props.current === number}
            render={visible.has(number)}
            onSelect={() => props.onSelect(number)}
          />
        );
      })}
    </div>
  );
}

function PdfThumb(props: {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  active: boolean;
  render: boolean;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scale = THUMB_WIDTH / props.width;
  const height = Math.round(props.height * scale);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!props.render || canvas === null) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void (async () => {
      const page = await props.doc.getPage(props.number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const renderTask = page.render({
        canvas,
        viewport,
        ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
      });
      task = renderTask;
      await renderTask.promise;
    })().catch((cause: unknown) => {
      if (cause instanceof RenderingCancelledException || cancelled) return;
      console.error(`[pdf] 第 ${props.number} 页缩略图失败`, cause);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [props.doc, props.number, props.render, scale]);

  return (
    <button
      type="button"
      className={`pdf-thumb${props.active ? " active" : ""}`}
      data-page={props.number}
      aria-current={props.active ? "page" : undefined}
      title={String(props.number)}
      onClick={props.onSelect}
    >
      <span className="pdf-thumb-frame" style={{ height }}>
        {props.render && <canvas ref={canvasRef} className="pdf-thumb-canvas" />}
      </span>
      <span className="pdf-thumb-number">{props.number}</span>
    </button>
  );
}
