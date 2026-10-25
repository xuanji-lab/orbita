import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import { PREVIEW_LINES_PER_READ, PREVIEW_MAX_LINE_BYTES, PREVIEW_TEXT_LIMIT } from "@shared/files";
import { formatSize } from "./tree-view";
import { truncatedNotice, WINDOW_OVERSCAN } from "./preview-view";
import { WindowedText } from "./WindowedText";
import { EmptyPreview, PreviewNotice } from "./PreviewChrome";
import { useRowHeight } from "./useRowHeight.ts";
import {
  MAX_VIRTUAL_HEIGHT,
  findCachedWindow,
  initialScrollLine,
  isLogLikeName,
  lineAtScroll,
  rememberWindow,
  scrollLineForJump,
  visibleLineCount,
  windowCovers,
  windowStartFor,
  type CachedWindow,
  type RangeJump,
} from "./range-view.ts";

/**
 * 大于 `PREVIEW_TEXT_LIMIT`（16 MB）的文本的分段预览：**不把整份文件读进 renderer**，
 * 只按当前滚动位置向主进程要那一窗行（`fs:line-index` 建索引 → `fs:read-lines` 取窗）。
 * renderer 的内存因此与文件体积无关：DOM 里一窗 600 行 + 缓存 5 窗，主进程那边一份
 * 十几 KB 的检查点表。
 *
 * 为什么需要它：PR #279 把上限抬到 16 MB 之后，再大的日志就只能看开头（`truncated`），
 * 而开发现场最常见的正是几十上百 MB 的 `*.log`——用户要看的是末尾。分段之后「打开
 * 100 MB 日志 → 直接落在末尾、能往回滚」成为默认行为，且滚到哪儿都只花一次 ~1 ms 的读盘。
 *
 * 几处不显然的规矩：
 * - **滚动层仍是外层的 `.file-preview-body`**（`scroller` prop）：滚动条、面板内边距、
 *   滚轮手感与其它预览形态一致。原生滚动高度 = 总行数 × 行高；超过 Chromium 的
 *   33 M px 上限的文件在建索引那一层就已经被挡掉（`PREVIEW_MAX_INDEXED_LINES`），
 *   行高被界面字号撑大的情况由 `MAX_VIRTUAL_HEIGHT` 兜底。
 * - **旧窗口留到新数据到**：滚动时不先清空，取窗回来原地替换——否则每滚一次都闪一次白。
 * - **过期响应一律丢弃**（generation token）：快速滚动、切文件、关标签时在途的响应
 *   不能把旧文件的行走进新文件的窗口。
 * - 行高没量出来之前（首帧）先渲染空的高度容器 + 探针，量到再摆行——绝不先整份渲染。
 */
export function RangeTextPreview(props: {
  sessionId: string | null;
  workspaceId: string | null;
  extraWorkspaceId: string | null;
  root: string;
  /** 文件绝对路径（fs:list 的 dir 语义） */
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  /** 已经读进 renderer 的前 16 MB：索引不可用（超长单行）时退回窗口化渲染它 */
  headText: string;
  /** 外层滚动容器（`.file-preview-body`） */
  scroller: RefObject<HTMLDivElement | null>;
  /** 换文件时重置滚动与窗口 */
  resetKey: string;
  /** 「刷新」按一下要让同一份文件重新索引（文件没变时 mtime 也不变） */
  reloadKey: number;
  /** 用默认应用打开（出口与空态同一条 IPC） */
  onOpenDefault: () => void;
}) {
  const t = useT();
  const logLike = isLogLikeName(props.name);
  const [index, setIndex] = useState<IndexState>({ status: "loading" });
  const [win, setWin] = useState<CachedWindow | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 行块容器：量行高时用「整块高度 / 行数」（单个元素离视口远时 rect 会被吸附成整数）
  const linesRef = useRef<HTMLDivElement | null>(null);
  const { probeRef, rowHeight } = useRowHeight(linesRef);

  const cacheRef = useRef<Map<number, CachedWindow>>(new Map());
  const genRef = useRef(0);
  const indexRef = useRef<{ indexId: string; totalLines: number } | null>(null);
  const winRef = useRef<CachedWindow | null>(null);
  const busyRef = useRef(false);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;
  /** 取窗函数每次渲染都会重建（读的都是 ref），挂到 ref 上给 effect / 回调用，避免陈旧闭包 */
  const loadRef = useRef<(first: number, rows: number) => void>(() => undefined);

  const { sessionId, workspaceId, extraWorkspaceId, root, path } = props;

  // 建索引（换文件 / 文件变了 / 用户点了刷新 / 失败重试都重来一次）
  useEffect(() => {
    const gen = (genRef.current += 1);
    indexRef.current = null;
    winRef.current = null;
    busyRef.current = false;
    cacheRef.current.clear();
    setWin(null);
    setIndex({ status: "loading" });
    api.files
      .lineIndex({ sessionId, workspaceId, extraWorkspaceId, root, dir: path })
      .then((result) => {
        if (genRef.current !== gen) return;
        switch (result.kind) {
          case "ok":
            indexRef.current = { indexId: result.indexId, totalLines: result.totalLines };
            setIndex({ status: "ready", indexId: result.indexId, totalLines: result.totalLines });
            break;
          case "empty":
            setIndex({ status: "empty" });
            break;
          case "long-line":
            setIndex({ status: "long-line" });
            break;
          case "too-many-lines":
            setIndex({ status: "too-many-lines", limit: result.limit });
            break;
          case "binary":
            // fs:read 已经判过二进制，走不到这里；文件在两次调用之间被重写成二进制时
            // 如实当空态，不假装能按行读
            setIndex({ status: "empty" });
            break;
        }
      })
      .catch((cause: unknown) => {
        if (genRef.current === gen) setIndex({ status: "error", message: failMessage(cause) });
      });
  }, [sessionId, workspaceId, extraWorkspaceId, root, path, props.size, props.modifiedAt, props.reloadKey, attempt]);

  // 当前视口要哪一段（首行 + 可见行数）；行高 / 滚动容器还没就绪时 null
  const viewport = (): { first: number; rows: number } | null => {
    const scroller = props.scroller.current;
    if (scroller === null || rowHeightRef.current <= 0) return null;
    return {
      first: lineAtScroll(scroller.scrollTop, rowHeightRef.current),
      rows: visibleLineCount(scroller.clientHeight, rowHeightRef.current),
    };
  };

  /**
   * 让窗口盖住可视区：先用当前窗口，再查缓存，最后才问主进程。
   * 在途请求只允许一个——滚动事件每帧都来，不排队就会把同一段重复读十遍。
   */
  const loadWindow = (first: number, rows: number): void => {
    const ready = indexRef.current;
    if (ready === null) return;
    const end = Math.min(ready.totalLines, first + Math.max(1, rows));
    if (windowCovers(winRef.current, first, end)) return;
    const cached = findCachedWindow(cacheRef.current, first, end);
    if (cached !== null) {
      winRef.current = cached;
      setWin(cached);
      return;
    }
    if (busyRef.current) return;
    const start = windowStartFor(first, ready.totalLines, PREVIEW_LINES_PER_READ, WINDOW_OVERSCAN, rows);
    busyRef.current = true;
    const gen = genRef.current;
    api.files
      .readLines({ indexId: ready.indexId, startLine: start, count: PREVIEW_LINES_PER_READ })
      .then((result) => {
        if (genRef.current !== gen) return;
        busyRef.current = false;
        if (result.kind === "stale") {
          setIndex({ status: "error", message: t.files.rangeStale });
          return;
        }
        const next: CachedWindow = { start: result.startLine, lines: result.lines };
        rememberWindow(cacheRef.current, next);
        // 先落下这一窗（旧窗口因此不会先清空，不闪白），再看它是不是还在可视区：
        // 在途期间滚远了就再要一次；算出来的起点与刚拿到的一样就收下（可视区比一窗
        // 还高这种极端情况），否则同一起点会每次又请求一遍。
        winRef.current = next;
        setWin(next);
        const need = viewport();
        if (need === null) return;
        const needEnd = Math.min(ready.totalLines, need.first + need.rows);
        if (windowCovers(next, need.first, needEnd)) return;
        const corrected = windowStartFor(need.first, ready.totalLines, PREVIEW_LINES_PER_READ, WINDOW_OVERSCAN, need.rows);
        if (corrected !== next.start) loadRef.current(need.first, need.rows);
      })
      .catch((cause: unknown) => {
        if (genRef.current !== gen) return;
        busyRef.current = false;
        setIndex({ status: "error", message: failMessage(cause) });
      });
  };
  loadRef.current = loadWindow;

  // 首屏位置：日志落在末尾（滚到最底），其它落在开头。索引号换了才重来一次。
  const settledRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (index.status !== "ready") {
      settledRef.current = null;
      return;
    }
    const scroller = props.scroller.current;
    if (scroller === null || rowHeight <= 0) return;
    if (settledRef.current === index.indexId) return;
    settledRef.current = index.indexId;
    const rows = visibleLineCount(scroller.clientHeight, rowHeight);
    scroller.scrollTop = initialScrollLine(index.totalLines, rows, logLike) * rowHeight;
    loadRef.current(lineAtScroll(scroller.scrollTop, rowHeight), rows);
  }, [index, rowHeight, logLike, props.scroller]);

  // 滚动 / 容器尺寸变化 → 视口变了才要新窗（窗口盖得住就什么都不做）
  useLayoutEffect(() => {
    const scroller = props.scroller.current;
    if (scroller === null || index.status !== "ready" || rowHeight <= 0) return;
    const update = (): void => {
      loadRef.current(
        lineAtScroll(scroller.scrollTop, rowHeight),
        visibleLineCount(scroller.clientHeight, rowHeight),
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [index, rowHeight, props.scroller]);

  /**
   * 跳开头 / 50% / 结尾：设完 `scrollTop` **显式要一次窗**。
   *
   * 只靠 scroll 事件是不够的：程序化改 `scrollTop` 在 Electron / 某些主题下不一定派发
   * scroll（真机实测：点「开头」后 scrollTop 已是 0，行窗却停在末尾六秒不动）。用户
   * 点按钮走的也是这条路径，所以跟初始落位一样直接调 `loadRef`。它幂等：窗口已盖住
   * 可视区就直接返回，滚动事件再来一次也不会多发请求。用户滚轮仍走监听。
   */
  const jump = (where: RangeJump): void => {
    if (index.status !== "ready") return;
    const scroller = props.scroller.current;
    if (scroller === null || rowHeight <= 0) return;
    const rows = visibleLineCount(scroller.clientHeight, rowHeight);
    scroller.scrollTop = scrollLineForJump(index.totalLines, rows, where) * rowHeight;
    loadRef.current(lineAtScroll(scroller.scrollTop, rowHeight), rows);
  };

  if (index.status === "loading") {
    return (
      <div className="file-preview-loading">
        <Icon name="loader-circle" size={14} spin />
        {t.common.loading}
      </div>
    );
  }
  if (index.status === "empty") {
    return <EmptyPreview message={t.files.emptyFile} onOpenDefault={props.onOpenDefault} />;
  }
  if (index.status === "error") {
    return (
      <div className="file-preview-error">
        <PanelLine danger>{index.message}</PanelLine>
        <PanelButton onClick={() => setAttempt((n) => n + 1)}>{t.common.retry}</PanelButton>
        <PanelButton onClick={props.onOpenDefault}>
          <Icon name="external-link" size={14} />
          {t.files.openDefault}
        </PanelButton>
      </div>
    );
  }
  if (index.status === "long-line") {
    // 单行超过 64 KB：一条行无法再窗口化，退回 PR #279 的「前 16 MB + 长行硬切」
    return (
      <>
        <PreviewNotice
          messages={[
            truncatedNotice(PREVIEW_TEXT_LIMIT, props.size, t),
            t.files.rangeLongLine(formatSize(PREVIEW_MAX_LINE_BYTES)),
          ]}
          actions={[{ label: t.files.openDefault, icon: "external-link", onClick: props.onOpenDefault }]}
        />
        <WindowedText text={props.headText} scroller={props.scroller} resetKey={props.resetKey} />
      </>
    );
  }

  // 行数太多（>1.8 M 行，或界面字号把行高撑大后超过 Chromium 的滚动高度）：
  // 滚动条映射不了全文位置，只给诚实的出口，不硬撑
  const totalHeight = index.status === "ready" ? index.totalLines * rowHeight : 0;
  if (index.status === "too-many-lines" || (rowHeight > 0 && totalHeight > MAX_VIRTUAL_HEIGHT)) {
    const limit = index.status === "too-many-lines" ? index.limit : index.totalLines;
    return <EmptyPreview message={t.files.rangeTooManyLines(limit)} onOpenDefault={props.onOpenDefault} />;
  }
  if (index.status !== "ready") return null;

  return (
    <>
      <PreviewNotice
        sticky
        messages={[
          t.files.rangeNotice(formatSize(props.size), index.totalLines),
          ...(logLike ? [t.files.rangeOpenedAtEnd] : []),
        ]}
        actions={[
          { label: t.files.rangeJumpHead, onClick: () => jump("head") },
          { label: t.files.rangeJumpMiddle, onClick: () => jump("middle") },
          { label: t.files.rangeJumpTail, onClick: () => jump("tail") },
          { label: t.files.openDefault, icon: "external-link", onClick: props.onOpenDefault },
        ]}
      />
      {/* 高度容器撑出全文的滚动长度；行块整体 translateY 到这一窗的起点 */}
      <div className="file-preview-window" style={{ height: totalHeight }}>
        <div className="file-preview-window-probe" ref={probeRef} aria-hidden>
          Ag
        </div>
        <div
          className="file-preview-window-lines"
          ref={linesRef}
          style={{ transform: `translateY(${(win === null ? 0 : win.start) * rowHeight}px)` }}
        >
          {(win === null ? [] : win.lines).map((line, at) => (
            // 空行也得占一行：给个空格，否则空 div 没有行盒、高度塌成 0
            <div className="file-preview-window-line" key={(win === null ? 0 : win.start) + at}>
              {line === "" ? " " : line}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

type IndexState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; indexId: string; totalLines: number }
  | { status: "empty" }
  | { status: "long-line" }
  | { status: "too-many-lines"; limit: number };

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
