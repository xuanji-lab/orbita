/**
 * 对话里 `show_plugin_board` 的结果：一块看板（BoardGrid 容器模式，宽 = 对话列宽），每张卡按**快照**画——
 * 模板用哈希换（`board:frame`），数据是调用那一刻的快照，所以重开会话、插件的模板后来改了，卡还是当时的样子。
 * 卡里的按钮照常可点：动作写进插件数据目录的 actions.jsonl（草稿还没装，不记）。
 * 被跳过的卡（数据太大、模板读不出来……）在卡下面一行灰字说明。
 *
 * **展开 / 收起是原地的**（2026-11-23 用户：「这个展开不是真的展开」）：收起时限高约半屏、底部渐隐「展开」；
 * 展开后去掉限高、在对话里完整显示这一次的快照，底部出「收起」。展开状态按 toolCallId 记在内存里（board-expand.ts）。
 * 去插件页看（那里是插件**现在**的数据）降成次要入口：悬停时看板右上角的小图标「在插件里打开」。
 *
 * **离开视口约一屏就卸掉 iframe，只留同高占位**：每张卡是一只沙箱 iframe（约 3 MB），对话没有虚拟化，
 * 长会话里反复展示看板会一直累积（20 次 × 4 张 = 80 只 ≈ 237 MB，实测）。占位高度由卡的尺寸与量到的宽度
 * 算出（`gridHeight`，与真实排版一致），所以卸 / 挂都不会让对话滚动跳动；回到视口再挂、重新换一次性地址。
 * 与周看板挂载「可视 ± 1 天」同一思路。
 *
 * **切走再切回不白一帧**：重挂后 iframe 要重新换地址、加载、收数据，这段时间外框里先贴上一次画好的样子（位图，
 * `board-shot-cache.ts`），等真 iframe 全部加载并合成后再换下。位图是宿主窗口在 iframe 画好后、页面空闲时预先截的（`board:shot`），
 * 切走 / 卸载时不截——切走那一下不付任何留图的代价；
 * 1:1 贴、钉在截下来的位置：右栏开合的过渡里宽度每帧都在变，宽度对不上就拿同一块看板最接近的一张，多出来的由外框裁掉。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PluginBoardResult as PluginBoardSnapshotResult } from "../../../../shared/plugin-board.ts";
import { useT } from "../../locale.ts";
import { api } from "../../api.ts";
import { Icon } from "../../shell/Icon";
import { requestOpenPluginBoard } from "../../shell/open-panel.ts";
import { BoardGrid } from "../plugins/BoardGrid.tsx";
import { containerLayout, gridHeight } from "../plugins/board-layout.ts";
import { boardClip, boardExpandStore, collapseScrollDelta } from "./board-expand.ts";
import {
  boardShotCovering,
  boardShotFor,
  boardShotGeometrySame,
  boardShotKey,
  boardShotRgba,
  boardShotVariantKey,
  boardShotView,
  boardShots,
  idleAfter,
  type IdleScheduler,
  type BoardShot,
  type BoardShotGeometry,
  type BoardShotView as BoardView,
} from "./board-shot-cache.ts";
import { skippedText } from "./board-text.ts";
import { useSnapshotCards, type SnapshotCardInput } from "./useSnapshotCards.ts";
import "./board.css";

/** 视口上下各多算一屏（根的高度的 100%）：这个范围里的看板挂 iframe，之外只留占位 */
const NEAR_MARGIN = "100% 0px";
/** 对话的滚动容器；找不到（别处复用）就按浏览器视口 */
const SCROLL_ROOT = ".chat-transcript";
/** 收起时看板顶部与滚动容器顶部之间留的边距（像素） */
const COLLAPSE_MARGIN = 12;
/**
 * 真 iframe 画好后隔这么久试着留位图（毫秒，依次是第 1、2、3 次）。首次给模板里的图片、字体与会话 / 右栏的过渡留出时间；
 * 那一次没存上（截到空白、几何一直在动、那一片看不见）就再试，存上了后两次什么都不做。
 */
const CAPTURE_ATTEMPT_DELAYS_MS = [600, 1600, 3100];
/** 展开看板滚动停下这么久后，给新露出来的那一片也留一张；滚动过程中只重置一个计时器，不逐帧 setState */
const SCROLL_CAPTURE_DELAY_MS = 400;
/** 留图前等几何连续这么多帧不动（虚拟列表测高、阅读位置恢复会在 iframe 就绪后继续挪页面）；最多等这么多帧 */
const SETTLE_FRAMES = 2;
const SETTLE_FRAME_LIMIT = 60;

/** 浏览器的计时器与空闲回调（idleAfter 的依赖；requestIdleCallback 不在时为 undefined） */
function browserScheduler(): IdleScheduler {
  return {
    setTimeout: (run, delay) => window.setTimeout(run, delay),
    clearTimeout: (id) => window.clearTimeout(id),
    requestIdle: typeof window.requestIdleCallback === "function" ? (run, timeout) => window.requestIdleCallback(run, { timeout }) : undefined,
    cancelIdle: (id) => window.cancelIdleCallback(id),
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** 窗口高度（随窗口缩放更新）：算「限高后是否被裁」要用 */
function useWindowHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

export function PluginBoardResultView(props: { sessionId: string | null; toolCallId: string; board: PluginBoardSnapshotResult }) {
  const t = useT().board;
  const { board, toolCallId, sessionId } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "");
  /** 此刻看得见的那一片（从看板顶部往下多少、多高）：决定贴哪张位图、贴在哪 */
  const [view, setView] = useState<BoardView | null>(null);
  const capturing = useRef(false);
  const cacheKey = sessionId === null ? null : boardShotKey(sessionId, toolCallId);

  /** 此刻的几何：外框矩形、看得见的那一片（与滚动容器的交集）、滚动位置。外框不在页面上了回 null */
  const geometry = useCallback((): BoardShotGeometry | null => {
    const clip = hostRef.current?.querySelector<HTMLElement>(".board-clip");
    if (clip === null || clip === undefined || !clip.isConnected) return null;
    const rect = clip.getBoundingClientRect();
    const root = clip.closest<HTMLElement>(SCROLL_ROOT);
    const rootRect = root?.getBoundingClientRect();
    const visible = boardShotView({ top: rect.top, height: rect.height }, { top: rootRect?.top ?? 0, bottom: rootRect?.bottom ?? window.innerHeight });
    if (visible === null) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, view: visible, scrollTop: root?.scrollTop ?? 0 };
  }, []);

  // 量自己的宽度（layout effect：占位在第一帧画出来之前就有对的高度）
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    setWidth(host.clientWidth);
    const observer = new ResizeObserver(() => setWidth(host.clientWidth));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  // 主题变化后模板会重新收到配色；缓存也按主题分开，浅色的图不能贴到玄上
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(root.dataset.theme ?? ""));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  // 在不在视口附近
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const root = host.closest(SCROLL_ROOT);
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { root, rootMargin: NEAR_MARGIN });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const placeholderHeight = useMemo(
    () => gridHeight(containerLayout(width), board.cards.map((card) => card.size)),
    [width, board.cards],
  );
  const skipped = skippedText(t, board.skipped);
  const live = near && board.cards.length > 0;
  // 收起时限高约半屏、展开去掉限高。占位与挂着的看板用同一个外框，卸 / 挂不让对话滚动跳动；
  // 展开后外框高度 = 占位高度（gridHeight 与真实排版一致），所以长内容离开视口卸 iframe 也不会跳
  const expanded = useSyncExternalStore(boardExpandStore.subscribe, () => boardExpandStore.has(toolCallId));
  const windowHeight = useWindowHeight();
  const clip = boardClip({ contentHeight: placeholderHeight, windowHeight, expanded });
  const visibleHeight = clip.maxHeight ?? placeholderHeight;

  // 量此刻看得见的那一片。外框的高度由宽度和限高算出来，要等它们落到布局上再量，所以挂在它们后面的 layout effect 里；
  // 挂上 iframe、原地展开 / 收起、窗口缩放后重量。滚动不跟：位图钉在看板上，跟着看板走
  useLayoutEffect(() => {
    const measure = (): void => {
      const next = geometry()?.view ?? null;
      setView((previous) =>
        previous !== null && next !== null && Math.abs(previous.top - next.top) < 0.5 && Math.abs(previous.height - next.height) < 0.5 ? previous : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [geometry, width, live, expanded]);

  /** 真 iframe 已经画好：截宿主窗口里此刻看得见的那一片，给下一次重挂用。失败只放弃优化，不影响正常加载。 */
  const capture = useCallback(async (): Promise<void> => {
    const clip = hostRef.current?.querySelector<HTMLElement>(".board-clip");
    if (cacheKey === null || clip === null || clip === undefined || capturing.current) return;
    // 窗口在后台（最小化、被切走）时不截：截到的未必是屏幕上的样子，也不跟前台抢主进程
    if (document.visibilityState !== "visible") return;
    // 有卡坏了 / 还没都挂上时不截：残缺画面不该成为下次的第一帧
    if (clip.querySelectorAll("iframe.bd-iframe").length !== board.cards.length) return;
    const ratio = window.devicePixelRatio || 1;
    const before = geometry();
    if (before === null) return;
    // 这一片已经有图盖着就不再截：每次切回都会走到这里，截一张要主进程整页取帧
    if (boardShotCovering(cacheKey, { width: before.width, ...before.view, ratio, theme, now: Date.now() }) !== undefined) return;
    capturing.current = true;
    try {
      // 量矩形与截像素不在同一刻：先等几何连续几帧不动，截完再核一次，动了就丢（否则贴回来只剩某个局部）
      let settled = before;
      let same = 0;
      for (let frames = 0; same < SETTLE_FRAMES && frames < SETTLE_FRAME_LIMIT; frames += 1) {
        await nextFrame();
        const next = geometry();
        if (next === null) return;
        same = boardShotGeometrySame(next, settled) ? same + 1 : 0;
        settled = next;
      }
      if (same < SETTLE_FRAMES) return;
      const { view } = settled;
      const result = await api.board.shot({ rect: { x: settled.x, y: settled.y + view.top, width: settled.width, height: view.height } });
      // 取帧期间已经切走 / 挪了位置、尺寸或主题：这份旧图不能落地，也不必再花工夫转换
      const moved = (): boolean => {
        const after = geometry();
        return after === null || !boardShotGeometrySame(after, settled) || (document.documentElement.dataset.theme ?? "") !== theme;
      };
      if (result === null || moved()) return;
      const rgba = boardShotRgba(result.pixels, result.width, result.height);
      if (rgba === null) return;
      const bitmap = await createImageBitmap(new ImageData(rgba, result.width, result.height));
      if (moved()) {
        bitmap.close();
        return;
      }
      const stored: BoardShot = { bitmap, cacheKey, cssTop: view.top, cssWidth: settled.width, cssHeight: view.height, ratio, theme, capturedAt: Date.now() };
      boardShots.set(boardShotVariantKey(cacheKey, stored), stored);
    } catch {
      // 截不到只等于没有这张图，正常 iframe 路径不受影响
    } finally {
      capturing.current = false;
    }
  }, [board.cards.length, cacheKey, geometry, theme]);

  const onPainted = useCallback((): void => {
    setLiveReady(true);
  }, []);

  // 真 iframe 就绪后留位图；已经画着的看板改宽 / 展开 / 换主题也重新走一遍（那一片已经有图的话 capture 自己会跳过）
  useEffect(() => {
    if (!live || !liveReady) return undefined;
    const cancels = CAPTURE_ATTEMPT_DELAYS_MS.map((delay) =>
      idleAfter(browserScheduler(), delay, () => {
        void capture();
      }),
    );
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [width, expanded, theme, live, liveReady, capture]);

  useEffect(() => {
    if (!live) setLiveReady(false);
  }, [live]);

  // 原地展开的看板比对话区高：留过顶部以后再滚到中段，新露出来的那一片也要留图。只在滚动停下后做一次；
  // 已经有图盖住这一片时 capture 会直接返回，不产生 IPC
  useEffect(() => {
    if (!live || !liveReady) return undefined;
    const root = hostRef.current?.closest<HTMLElement>(SCROLL_ROOT);
    if (root === null || root === undefined) return undefined;
    let cancel: (() => void) | undefined;
    const onScroll = (): void => {
      cancel?.();
      cancel = idleAfter(browserScheduler(), SCROLL_CAPTURE_DELAY_MS, () => {
        void capture();
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancel?.();
      root.removeEventListener("scroll", onScroll);
    };
  }, [capture, live, liveReady]);

  const shot =
    cacheKey === null || width === 0 || view === null
      ? undefined
      : boardShotFor(cacheKey, { width, ...view, ratio: window.devicePixelRatio || 1, theme, now: Date.now() });
  const pasteShot = shot !== undefined && (!live || !liveReady);
  const collapse = (): void => {
    // 「收起」钮在展开的看板最底下：整块缩回半屏后，顶部若在视口上方就把它拉回视口里，别让用户迷路
    // （行在虚拟列表里是绝对定位，缩短不挪它的顶；下面的行等测高后才补位，所以这里直接按现在的顶部算）
    const host = hostRef.current;
    const root = host?.closest<HTMLElement>(SCROLL_ROOT) ?? null;
    if (host !== null && root !== null) {
      const delta = collapseScrollDelta(host.getBoundingClientRect().top, root.getBoundingClientRect().top, COLLAPSE_MARGIN);
      if (delta !== 0) root.scrollTop += delta;
    }
    boardExpandStore.set(toolCallId, false);
  };
  return (
    <div className="board-result" data-source={board.source} data-live={live} data-board-call={toolCallId} data-expanded={expanded || undefined} ref={hostRef}>
      <div
        className="board-clip"
        data-clipped={clip.clipped || undefined}
        data-shot={pasteShot || undefined}
        style={{ minHeight: visibleHeight, ...(clip.maxHeight === null ? {} : { maxHeight: clip.maxHeight }) }}
      >
        {live && <LiveBoard toolCallId={toolCallId} board={board} onPainted={onPainted} />}
        {!live && !pasteShot && board.cards.length > 0 && <div className="board-placeholder" style={{ height: placeholderHeight }} aria-hidden="true" />}
        {pasteShot && <BoardShotView shot={shot} />}
        {clip.clipped && (
          <button type="button" className="board-more" title={t.expandHint} onClick={() => boardExpandStore.set(toolCallId, true)}>
            <Icon name="chevron-down" size={14} />
            {t.expand}
          </button>
        )}
        <button
          type="button"
          className="board-open"
          title={t.openInPlugin}
          aria-label={t.openInPlugin}
          onClick={() => requestOpenPluginBoard({ plugin: board.plugin, draftPath: board.draftPath })}
        >
          <Icon name="external-link" size={14} />
        </button>
      </div>
      {clip.foldable && expanded && (
        <button type="button" className="board-fold" title={t.collapseHint} onClick={collapse}>
          <Icon name="chevron-up" size={14} />
          {t.collapse}
        </button>
      )}
      {skipped !== null && <p className="board-result-note">{skipped}</p>}
    </div>
  );
}

/** 位图同步贴上（layout effect）：挂载后的第一帧就有内容，不等 PNG 再解码一次。1:1 钉在它截下来的位置，多出来的由外框裁掉 */
function BoardShotView(props: { shot: BoardShot }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    canvas.width = props.shot.bitmap.width;
    canvas.height = props.shot.bitmap.height;
    canvas.getContext("2d")?.drawImage(props.shot.bitmap, 0, 0);
  }, [props.shot]);
  return <canvas ref={ref} className="board-shot" style={{ top: props.shot.cssTop, width: props.shot.cssWidth, height: props.shot.cssHeight }} aria-hidden="true" />;
}

/** 挂着的看板：换地址的 hook 在这里——卸载即丢掉已用掉的一次性地址，再挂载重新换 */
function LiveBoard(props: { toolCallId: string; board: PluginBoardSnapshotResult; onPainted: () => void }) {
  const { board, toolCallId, onPainted } = props;
  const inputs = useMemo<SnapshotCardInput[]>(
    () => board.cards.map((snapshot) => ({ key: `${toolCallId}:${snapshot.id}:${snapshot.index}`, snapshot, at: board.at })),
    [board, toolCallId],
  );
  const { cards, refresh } = useSnapshotCards(inputs);
  const loaded = useRef(new Set<string>());
  const completed = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const fallback = useRef<number | undefined>(undefined);
  const frameOne = useRef(0);
  const frameTwo = useRef(0);
  const complete = useCallback((): void => {
    if (completed.current) return;
    completed.current = true;
    window.clearTimeout(timer.current);
    window.clearTimeout(fallback.current);
    onPainted();
  }, [onPainted]);
  // 正常路：全部 iframe load 后给模板收数据与合成留两帧；补路：模板缺失也不让旧位图永久盖住错误卡
  useEffect(() => {
    fallback.current = window.setTimeout(complete, 2000);
    return () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(fallback.current);
      cancelAnimationFrame(frameOne.current);
      cancelAnimationFrame(frameTwo.current);
    };
  }, [complete]);
  const onFrameLoad = useCallback(
    (key: string): void => {
      loaded.current.add(key);
      if (loaded.current.size < inputs.length || completed.current) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        frameOne.current = requestAnimationFrame(() => {
          frameTwo.current = requestAnimationFrame(complete);
        });
      }, 100);
    },
    [inputs.length, complete],
  );
  return (
    <BoardGrid
      cards={cards}
      layout={{ mode: "container" }}
      actionName={board.source === "installed" ? board.plugin : null}
      onFrameStale={refresh}
      onFrameLoad={onFrameLoad}
    />
  );
}
