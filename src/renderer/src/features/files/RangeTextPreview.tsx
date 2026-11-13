import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import {
  PREVIEW_LINES_PER_READ,
  PREVIEW_MAX_LINE_BYTES,
  PREVIEW_TEXT_LIMIT,
  type FileLineIndex,
} from "@shared/files";
import { formatSize } from "./tree-view";
import { truncatedNotice, WINDOW_OVERSCAN } from "./preview-view";
import { WindowedText } from "./WindowedText";
import { EmptyPreview, PreviewNotice } from "./PreviewChrome";
import { useRowHeight } from "./useRowHeight.ts";
import { useScrollHeightLimit } from "./useScrollHeightLimit.ts";
import {
  findCachedWindow,
  isLogLikeName,
  lineAtScroll,
  maxBrowsableLines,
  rememberWindow,
  middleLine,
  scrollTopForLine,
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
 * 十几 KB 的检查点表。连「前 16 MB」也不先读：`fs:read` 对这种文件只回 `large-text`，首帧
 * 经 IPC 的只有索引回执和第一窗 600 行。
 *
 * 为什么需要它：PR #279 把上限抬到 16 MB 之后，再大的日志就只能看开头（`truncated`），
 * 而开发现场最常见的正是几十上百 MB 的 `*.log`——用户要看的是末尾。分段之后「打开
 * 100 MB 日志 → 直接落在末尾、能往回滚」成为默认行为，且滚到哪儿都只花一次 ~1 ms 的读盘。
 *
 * 几处不显然的规矩：
 * - **滚动层仍是外层的 `.file-preview-body`**（`scroller` prop）：滚动条、面板内边距、
 *   滚轮手感与其它预览形态一致。原生滚动高度 = 总行数 × 行高，而浏览器能撑多高是**运行时
 *   才知道的**（`useScrollHeightLimit` 现量，随显示器缩放与页面缩放变）：行数超过
 *   「上限 ÷ 行高」就给空态 + 默认应用打开，缩放或换屏后重新判——**绝不静默滚不到底**。
 * - **行号 ↔ 滚动位置要扣掉行块上方的东西**（内边距 + 提示带，`contentTop`）；「结尾」不去
 *   算 scrollTop，直接滚到 `scrollHeight` 让浏览器夹到真正的底。
 * - **正在写入的日志**：主进程只在变长时接着扫索引，令牌不变；取窗回执里的 `totalLines`
 *   比手里的大就撑高容器。点「结尾」先问一次最新行数再滚，保证看得到刚写进去的行。
 *   文件被改写 / 令牌过期（`stale` / `expired`）自动重建索引，连续失败才报错。
 * - **旧窗口留到新数据到**：滚动时不先清空，取窗回来原地替换——否则每滚一次都闪白。
 * - **过期响应一律丢弃**（generation token）：快速滚动、切文件、关标签时在途的响应
 *   不能把旧文件的行走进新文件的窗口；换文件 / 卸载时通知主进程取消还在扫的那一遍。
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
  /** 撑出全文滚动长度的高度容器：量 contentTop 用 */
  const windowRef = useRef<HTMLDivElement | null>(null);
  const { probeRef, rowHeight } = useRowHeight(linesRef);
  const scrollLimit = useScrollHeightLimit();

  const cacheRef = useRef<Map<number, CachedWindow>>(new Map());
  const genRef = useRef(0);
  const indexRef = useRef<{ indexId: string; totalLines: number } | null>(null);
  const winRef = useRef<CachedWindow | null>(null);
  const busyRef = useRef(false);
  /** 连续自动重建索引的次数：取窗成功就清零，超过上限才把「文件一直在变」报给用户 */
  const rebuildsRef = useRef(0);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;
  /** 取窗函数每次渲染都会重建（读的都是 ref），挂到 ref 上给 effect / 回调用，避免陈旧闭包 */
  const loadRef = useRef<(first: number, rows: number) => void>(() => undefined);

  const { sessionId, workspaceId, extraWorkspaceId, root, path } = props;

  /**
   * 运行时量出的滚动高度上限 ÷ 行高 = 最多能浏览多少行。超过就滚不到底：空态 + 外部打开，
   * 不渲染行块。缩放 / 换屏后 `scrollLimit` 变了会自动重判（索引不用重建）。
   */
  const maxLines = maxBrowsableLines(scrollLimit, rowHeight);
  const tooTall = index.status === "ready" && rowHeight > 0 && index.totalLines > maxLines;

  const lineIndexRequest = (requestId: string) => ({
    sessionId,
    workspaceId,
    extraWorkspaceId,
    root,
    dir: path,
    requestId,
  });

  /**
   * 一份新的索引（或同一份变长了）落地。同令牌 = 只是变长，别的 = 文件被换了；两种都要把
   * 缓存的窗口作废（变长时最后一行可能刚被续写过）——旧窗口仍留在屏上，下一次取窗原地替换。
   */
  const acceptIndexed = (result: { indexId: string; totalLines: number }): void => {
    const ready = indexRef.current;
    if (ready !== null && ready.indexId === result.indexId && ready.totalLines === result.totalLines) return;
    cacheRef.current.clear();
    winRef.current = null;
    indexRef.current = { indexId: result.indexId, totalLines: result.totalLines };
    setIndex({ status: "ready", indexId: result.indexId, totalLines: result.totalLines });
  };

  // 建索引（换文件 / 文件变了 / 用户点了刷新 / 失败重试 / 自动重建都重来一次）
  useEffect(() => {
    const gen = (genRef.current += 1);
    const requestId = crypto.randomUUID();
    indexRef.current = null;
    winRef.current = null;
    busyRef.current = false;
    cacheRef.current.clear();
    setWin(null);
    setIndex({ status: "loading" });
    api.files
      .lineIndex(lineIndexRequest(requestId))
      .then((result) => {
        if (genRef.current !== gen) return;
        if (result.kind === "ok") acceptIndexed(result);
        else if (result.kind !== "cancelled") setIndex(indexStateOf(result));
      })
      .catch((cause: unknown) => {
        if (genRef.current === gen) setIndex({ status: "error", message: failMessage(cause) });
      });
    // 换文件 / 刷新 / 卸载：让主进程停掉还在扫的这一遍（已完成的请求发了也没有影响）
    return () => api.files.cancelLineIndex(requestId);
  }, [sessionId, workspaceId, extraWorkspaceId, root, path, props.size, props.modifiedAt, props.reloadKey, attempt]);

  /** 行块顶端在滚动内容里的位置（行块上方的内边距 + 提示带）；行块还没渲染时 0 */
  const contentTopOf = (scroller: HTMLDivElement): number => {
    const block = windowRef.current;
    if (block === null) return 0;
    return block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  };

  // 当前视口要哪一段（首行 + 可见行数）；行高 / 滚动容器还没就绪时 null
  const viewport = (): { first: number; rows: number } | null => {
    const scroller = props.scroller.current;
    if (scroller === null || rowHeightRef.current <= 0) return null;
    return {
      first: lineAtScroll(scroller.scrollTop, rowHeightRef.current, contentTopOf(scroller)),
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
        if (result.kind !== "text") {
          // stale = 文件被改写 / 截断；expired = 令牌被挤掉或应用重启过。两种都是「重新索引就好」，
          // 不该让用户看到红字再手点重试。正在被反复改写的文件才会撞到次数上限
          if (rebuildsRef.current >= MAX_AUTO_REBUILDS) {
            setIndex({ status: "error", message: t.files.rangeStale });
            return;
          }
          rebuildsRef.current += 1;
          setAttempt((n) => n + 1);
          return;
        }
        rebuildsRef.current = 0;
        // 正在写入的日志：回执里的总行数比手里的大，先撑高容器再落窗（落窗会按新总数算覆盖）
        if (result.totalLines !== ready.totalLines) acceptIndexed({ indexId: ready.indexId, totalLines: result.totalLines });
        const next: CachedWindow = { start: result.startLine, lines: result.lines };
        rememberWindow(cacheRef.current, next);
        // 先落下这一窗（旧窗口因此不会先清空，不闪白），再看它是不是还在可视区：
        // 在途期间滚远了就再要一次；算出来的起点与刚拿到的一样就收下（可视区比一窗
        // 还高这种极端情况），否则同一起点会每次又请求一遍。
        winRef.current = next;
        setWin(next);
        const need = viewport();
        const total = indexRef.current?.totalLines ?? result.totalLines;
        if (need === null) return;
        const needEnd = Math.min(total, need.first + need.rows);
        if (windowCovers(next, need.first, needEnd)) return;
        const corrected = windowStartFor(need.first, total, PREVIEW_LINES_PER_READ, WINDOW_OVERSCAN, need.rows);
        if (corrected !== next.start) loadRef.current(need.first, need.rows);
      })
      .catch((cause: unknown) => {
        if (genRef.current !== gen) return;
        busyRef.current = false;
        setIndex({ status: "error", message: failMessage(cause) });
      });
  };
  loadRef.current = loadWindow;

  /**
   * 滚到开头 / 50% / 结尾，**并显式要一次窗**。
   *
   * 只靠 scroll 事件是不够的：程序化改 `scrollTop` 在 Electron / 某些主题下不一定派发
   * scroll（真机实测：点「开头」后 scrollTop 已是 0，行窗却停在末尾六秒不动）。所以跟
   * 初始落位一样直接调 `loadRef`。它幂等：窗口已盖住可视区就直接返回，滚动事件再来一次
   * 也不会多发请求。用户滚轮仍走监听。
   *
   * 结尾不自己算 scrollTop，而是滚到 `scrollHeight` 让浏览器夹到真正的底（原先
   * `(总行数 − 可见行数) × 行高` 没算行块上方的 ~114 px，最后 5 行落在视口下方）。
   */
  const applyJump = (where: RangeJump): void => {
    const ready = indexRef.current;
    const scroller = props.scroller.current;
    const rh = rowHeightRef.current;
    if (ready === null || scroller === null || !(rh > 0)) return;
    const rows = visibleLineCount(scroller.clientHeight, rh);
    const top = contentTopOf(scroller);
    // 开头回到 0（提示带在行块之上，滚到行块顶端会让前几行躲到钉住的提示带底下）
    scroller.scrollTop =
      where === "tail"
        ? scroller.scrollHeight
        : where === "head"
          ? 0
          : scrollTopForLine(middleLine(ready.totalLines, rows), rh, top);
    loadRef.current(lineAtScroll(scroller.scrollTop, rh, top), rows);
  };

  // 首屏位置：日志落在末尾，其它落在开头。索引号换了才重来一次。放不下（tooTall）时行块被卸掉、
  // 滚动容器的内容换成了空态，滚动位置随之归零——所以也算「没落位」，缩放后又放得下了要重新落
  const settledRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (index.status !== "ready" || tooTall) {
      settledRef.current = null;
      return;
    }
    if (rowHeight <= 0 || props.scroller.current === null) return;
    if (settledRef.current === index.indexId) return;
    settledRef.current = index.indexId;
    applyJump(logLike ? "tail" : "head");
  }, [index, rowHeight, logLike, tooTall, props.scroller]);

  // 滚动 / 容器尺寸变化 → 视口变了才要新窗（窗口盖得住就什么都不做）
  useLayoutEffect(() => {
    const scroller = props.scroller.current;
    if (scroller === null || index.status !== "ready" || rowHeight <= 0 || tooTall) return;
    const update = (): void => {
      const need = viewport();
      if (need !== null) loadRef.current(need.first, need.rows);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [index, rowHeight, tooTall, props.scroller]);

  /**
   * 点跳转。「结尾」先问一次最新的行数：正在写入的日志，手里的总数早就过时了，直接滚
   * 就停在旧末尾。主进程只在文件变长时接着扫（几毫秒），拿到新总数、容器撑高之后再滚。
   * 问失败（文件被删了之类）不挡跳转，照旧滚到手里知道的末尾。
   */
  const jump = (where: RangeJump): void => {
    if (index.status !== "ready" || tooTall) return;
    if (where !== "tail") {
      applyJump(where);
      return;
    }
    const gen = genRef.current;
    api.files
      .lineIndex(lineIndexRequest(crypto.randomUUID()))
      .then((result) => {
        if (genRef.current !== gen) return;
        if (result.kind === "ok") {
          // flushSync：容器的高度要先按新总数撑开，scrollHeight 才是新的底
          flushSync(() => acceptIndexed(result));
        } else if (result.kind !== "cancelled") {
          // 文件在这期间变成了别的样子（超过字节上限、追进了超长行……）：按新的边界重画，不再滚
          setIndex(indexStateOf(result));
          return;
        }
        applyJump("tail");
      })
      .catch(() => {
        // 问不到最新行数（文件被删了之类）不挡跳转：照旧滚到手里知道的末尾
        if (genRef.current === gen) applyJump("tail");
      });
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
  if (index.status === "too-large") {
    // 超过主进程愿意扫一遍的字节数：如实给出口，不假装能浏览
    return (
      <EmptyPreview
        message={t.files.tooLarge(formatSize(props.size), formatSize(index.limit))}
        onOpenDefault={props.onOpenDefault}
      />
    );
  }
  if (index.status === "long-line") {
    // 单行超过 64 KB：一条行无法再窗口化，退回 PR #279 的「前 16 MB + 长行硬切」
    return (
      <>
        <PreviewNotice
          messages={[
            truncatedNotice(PREVIEW_TEXT_LIMIT, props.size, t),
            t.files.rangeLongLine(formatSize(PREVIEW_MAX_LINE_BYTES), formatSize(PREVIEW_TEXT_LIMIT)),
          ]}
          actions={[{ label: t.files.openDefault, icon: "external-link", onClick: props.onOpenDefault }]}
        />
        <WindowedText text={index.headText} scroller={props.scroller} resetKey={props.resetKey} />
      </>
    );
  }

  // 行数超过运行时量出的上限：滚动条映射不了全文位置，只给诚实的出口，不硬撑。
  // 探针元素仍然渲染（隐形、不占位），行高才会在界面字号变化时继续被量；它必须裹在
  // `.file-preview-window` 里——等宽字体 / 行高是那个类给的，放在外面量出来是另一个数（21 px 对 18.6 px），
  // 上限换算就错了
  if (tooTall) {
    return (
      <>
        <div className="file-preview-window" style={{ height: 0 }}>
          <div className="file-preview-window-probe" ref={probeRef} aria-hidden>
            Ag
          </div>
        </div>
        <EmptyPreview message={t.files.rangeTooTall(index.totalLines, maxLines)} onOpenDefault={props.onOpenDefault} />
      </>
    );
  }

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
      <div className="file-preview-window" ref={windowRef} style={{ height: index.totalLines * rowHeight }}>
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

/** 连续自动重建索引的上限：取窗成功就清零；文件被反复改写、重建也追不上时才报错 */
const MAX_AUTO_REBUILDS = 3;

type IndexState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; indexId: string; totalLines: number }
  | { status: "empty" }
  | { status: "long-line"; headText: string }
  | { status: "too-large"; limit: number };

/** 索引回执（ok 与 cancelled 之外的各种边界）→ 组件状态 */
function indexStateOf(result: Exclude<FileLineIndex, { kind: "ok" | "cancelled" }>): IndexState {
  switch (result.kind) {
    case "long-line":
      return { status: "long-line", headText: result.headText };
    case "too-large":
      return { status: "too-large", limit: result.limit };
    case "empty":
    case "binary":
      // binary：fs:read 已经判过，走不到这里；文件在两次调用之间被重写成二进制时如实当空态
      return { status: "empty" };
  }
}

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
