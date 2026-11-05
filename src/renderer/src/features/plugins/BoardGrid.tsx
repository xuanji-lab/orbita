/**
 * 看板网格与卡片宿主：把一组卡按固定的尺寸与比例排好，每张卡一只沙箱 iframe。
 *
 * **外框是 Orbita 的**：卡的四档尺寸、一格的宽高比、圆角（`--radius-xl`）、overflow hidden、卡外的标题行
 * 与「样例」标都由宿主画；模板只管框里（颜色、字号、背景都是插件的）。窗口放大缩小时整块等比缩放。
 *
 * **模板是不可信代码**（见 shared/plugin-panel.ts 与 main/plugin/panel-frame.ts），每张卡一只 iframe：
 * - `sandbox="allow-scripts"`，**不给** allow-same-origin / allow-top-navigation / allow-popups /
 *   allow-forms：模板拿不到我们的 DOM、window.top、Electron 与 preload，也开不了窗、跳不了顶层；
 * - 文档来自 `orbita-panel://` 协议，CSP 在响应头（不能联网、不能引外部资源）；
 * - 收消息只认**这只 iframe 的 contentWindow**，且来源必须是 `"null"`（沙箱不透明来源）——别的窗口、
 *   别的 iframe（含同一块看板里的别的卡）、拿到我们 window 引用的东西发来的一律丢掉；
 * - 往里发消息的 targetOrigin 只能是 `"*"`（不透明来源没有可写的 origin），所以发出去的内容只有
 *   数据、主题、卡的 id / 尺寸 / 序号与一格的像素——都是模板本来就该看到的，不含任何会话内容、密钥。
 *
 * **接口**（给全局周看板、会话里的结果用）：`BoardGrid` 吃一组 `BoardCardView`（谁来的数据都行：实时的插件、
 * 会话快照），自己负责布局与每张卡的收发。模板来源可替换——`frameUrl` 由调用方给（实时卡用主进程按插件路径
 * 注册的一次性地址，快照卡用 `board:frame` 按哈希注册的）。布局两种：`{ mode: "container" }` 量自己的宽度；
 * `{ mode: "column", cellWidth, … }` 格宽由外面给（周看板的一天）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { boardCardSpan, type BoardCardSize } from "@shared/plugin-board";
import {
  PANEL_DATA_MAX_BYTES,
  PANEL_READY_GRACE_MS,
  checkPanelAction,
  dataMessageParts,
  parsePanelMessage,
  type PanelDataMessage,
  type PanelTheme,
  type PluginPanelData,
  type PluginPanelDataProblem,
  type PluginPanelProblem,
} from "@shared/plugin-panel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import {
  cardBox,
  columnLayout,
  containerLayout,
  placedSpan,
  rowHeight,
  unitOf,
  type BoardLayout,
} from "./board-layout.ts";
import { CARD_IFRAME_SANDBOX, type BoardCardView } from "./board-card.ts";
import { actionFailureText, dataProblemText, panelProblemText, readPanelTheme, sameTheme, showHostEmpty } from "./panel-view.ts";
import "./plugin-panel.css";

export type { BoardCardView } from "./board-card.ts";

/** load 之后给模板发 ready 的时间；过了它还没有 ready 才由宿主盖「还没有产出」（别先闪一下再被换掉）。 */
const EMPTY_GRACE_MS = 400;
const TOAST_MS = 1800;
/** 卡上方宿主画的标题行高度（有 caption 时才占） */
export const BOARD_CAPTION_HEIGHT = 22;

export type BoardGridMode =
  /** 量自己的宽度：< 560px 一行 2 格，否则 4 格 */
  | { mode: "container" }
  /** 格宽（可选格高）与列宽由外面给：周看板的一天。`columns` 缺省按卡里最宽的算 */
  | { mode: "column"; cellWidth: number; cellHeight?: number; columns?: 1 | 2; gap?: number };

export interface BoardGridProps {
  cards: readonly BoardCardView[];
  layout: BoardGridMode;
  /** 卡里点按钮的动作写进哪个插件的 actions.jsonl；null = 不记录（草稿：插件还没装） */
  actionName: string | null;
  /** 卡上方宿主画的标题行（周看板的「时间 · 插件名」）；不给就没有这一行 */
  caption?: (card: BoardCardView) => ReactNode;
}

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "warn";
}

export function BoardGrid(props: BoardGridProps) {
  const { cards, layout: mode, caption } = props;
  const captionHeight = caption === undefined ? 0 : BOARD_CAPTION_HEIGHT;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const theme = usePanelTheme();
  const [toast, setToast] = useState<Toast | null>(null);
  const toastId = useRef(0);

  // 容器模式量自己的宽度（ResizeObserver）；窗口 / 右栏拖动时等比缩放
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null || mode.mode !== "container") return;
    setWidth(host.clientWidth);
    const observer = new ResizeObserver(() => setWidth(host.clientWidth));
    observer.observe(host);
    return () => observer.disconnect();
  }, [mode.mode]);

  const layout: BoardLayout =
    mode.mode === "container"
      ? containerLayout(width, captionHeight)
      : columnLayout({
          cellWidth: mode.cellWidth,
          ...(mode.cellHeight === undefined ? {} : { cellHeight: mode.cellHeight }),
          columns: mode.columns ?? (cards.some((card) => boardCardSpan(card.size).cols >= 2) ? 2 : 1),
          ...(mode.gap === undefined ? {} : { gap: mode.gap }),
          captionHeight,
        });
  const unit = unitOf(layout);

  const notify = useCallback((text: string, tone: Toast["tone"]) => {
    toastId.current += 1;
    setToast({ id: toastId.current, text, tone });
  }, []);
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const gridStyle = {
    gridTemplateColumns: `repeat(${layout.columns}, ${layout.cellWidth}px)`,
    gridAutoRows: `${rowHeight(layout)}px`,
    gap: `${layout.gap}px`,
  };
  return (
    <div className="bd-host" ref={hostRef} data-mode={mode.mode}>
      {/* 容器还没量到宽度时不画卡：避免先按 0 宽画一帧再弹开 */}
      {(mode.mode === "column" || width > 0) && (
        <div className="bd" style={gridStyle}>
          {cards.map((card) => {
            const span = placedSpan(layout, card.size);
            const box = cardBox(layout, card.size);
            return (
              <div key={card.key} className="bd-cell" style={{ gridColumn: `span ${span.cols}`, gridRow: `span ${span.rows}` }} data-size={card.size}>
                {caption !== undefined && (
                  <div className="bd-caption">
                    <span className="bd-caption-main">{caption(card)}</span>
                    {/* 有标题行时「样例」标画在框外的标题行里，不盖在卡上 */}
                    {card.usingSample && <SampleBadge />}
                  </div>
                )}
                <BoardCardFrame key={card.frameKey} sampleOutside={caption !== undefined} card={card} unit={unit} height={box.height} theme={theme} actionName={props.actionName} onNotify={notify} />
              </div>
            );
          })}
        </div>
      )}
      <div className="pp-toast-slot" role="status" aria-live="polite">
        {toast !== null && (
          <span key={toast.id} className="pp-toast" data-tone={toast.tone}>
            <Icon name={toast.tone === "ok" ? "check" : "triangle-alert"} size={13} strokeWidth={2} />
            {toast.text}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 一张卡：宿主画的外框（圆角、overflow hidden、「样例」标、问题条）+ 里面的沙箱 iframe。
 * 调用方用 `key={frameKey}` 挂它：模板换了（新 iframe）整张重建，loaded / ready 之类的状态跟着清零，数据会重新发进新 iframe。
 */
function BoardCardFrame(props: {
  /** 「样例」标已经画在框外的标题行里（BoardGrid 给了 caption）：框上不再盖一枚 */
  sampleOutside: boolean;
  card: BoardCardView;
  unit: { width: number; height: number };
  height: number;
  theme: PanelTheme;
  actionName: string | null;
  onNotify: (text: string, tone: Toast["tone"]) => void;
}) {
  const t = useT().pluginPanel;
  const { card, onNotify, actionName } = props;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [templateHandlesEmpty, setTemplateHandlesEmpty] = useState(false);
  const [graceOver, setGraceOver] = useState(false);

  const { theme, unit } = props;
  const shown = card.shown;
  const post = useCallback((): void => {
    const target = frame.current?.contentWindow;
    if (target === null || target === undefined) return;
    const message: PanelDataMessage = {
      type: "orbita:data",
      ...dataMessageParts(shown),
      theme,
      card: { id: card.id, size: card.size, index: card.index },
      unit: { width: unit.width, height: unit.height },
    };
    // 沙箱 iframe 的来源是不透明的，没有可写的 targetOrigin；我们只往自己手里这只 iframe 的 window 发
    target.postMessage(message, "*");
  }, [shown, theme, card.id, card.size, card.index, unit.width, unit.height]);
  const postRef = useRef(post);
  postRef.current = post;

  // 宿主在 iframe load 后主动发一次数据，不等模板的 ready——模板不发 ready 也看得到数据；
  // 数据、主题、一格的像素变了再发一次（post 的依赖就是它们）
  useEffect(() => {
    if (loaded) post();
  }, [loaded, post]);
  // 5 秒后再补发一次：模板的监听器若是晚于 load 才挂上的（异步初始化），也不至于一直是空的
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => postRef.current(), PANEL_READY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [loaded]);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => setGraceOver(true), EMPTY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [loaded]);

  const cardRef = useRef({ id: card.id, index: card.index });
  cardRef.current = { id: card.id, index: card.index };
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const target = frame.current?.contentWindow;
      // 只认这只 iframe；沙箱（无 allow-same-origin）的来源恒为 "null"
      if (target === null || target === undefined || event.source !== target || event.origin !== "null") return;
      const inbound = parsePanelMessage(event.data);
      if (inbound.kind === "ready") {
        setTemplateHandlesEmpty(inbound.emptyState);
        postRef.current();
        return;
      }
      if (inbound.kind !== "action") return;
      const checked = checkPanelAction(inbound.action, inbound.payload);
      if (!checked.ok) {
        onNotify(t.recordFailed(actionFailureText(t, checked.reason)), "warn");
        return;
      }
      // 草稿预览：插件还没装，没有数据目录可记，什么都不写，只告诉用户
      if (actionName === null) {
        onNotify(t.draftNotRecorded, "warn");
        return;
      }
      // 只做一件事：交给主进程追加进 actions.jsonl（带上是哪张卡点的）。宿主不据此执行任何别的
      api.plugin
        .panelAction({ name: actionName, action: checked.action, payload: checked.payload, card: cardRef.current })
        .then((result) => onNotify(result.ok ? t.recorded : t.recordFailed(actionFailureText(t, result.reason)), result.ok ? "ok" : "warn"))
        .catch((cause: unknown) => onNotify(t.recordFailed(cause instanceof Error ? cause.message : String(cause)), "warn"));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [actionName, onNotify, t]);

  const broken = card.brokenProblems !== null;
  const hostEmpty = !broken && card.frameUrl !== null && showHostEmpty({ shown, problem: card.problem, templateHandlesEmpty, graceOver });
  return (
    <div className="bd-frame" style={{ height: props.height }} title={card.title}>
      {broken ? (
        <div className="bd-broken" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <b>{t.cardBroken}</b>
          {(card.brokenProblems ?? []).slice(0, 3).map((problem, index) => (
            <span key={index}>{panelProblemText(t, problem)}</span>
          ))}
        </div>
      ) : card.frameUrl === null ? (
        <div className="bd-broken" role="status">
          <Icon name="circle-dashed" size={14} strokeWidth={1.8} />
          <span>{t.loading}</span>
        </div>
      ) : (
        <iframe
          key={card.frameKey}
          ref={frame}
          className="bd-iframe"
          title={card.title}
          src={card.frameUrl}
          // 只给脚本。不给 allow-same-origin（否则同源即可摸到我们的 DOM 与 preload）、
          // allow-top-navigation / allow-popups / allow-forms / allow-modals / allow-downloads
          sandbox={CARD_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          allow=""
          style={{ visibility: hostEmpty ? "hidden" : "visible" }}
          onLoad={() => setLoaded(true)}
        />
      )}
      {hostEmpty && (
        <div className="bd-empty">
          <Icon name="circle-dashed" size={20} strokeWidth={1.6} />
          <b>{t.noOutput}</b>
        </div>
      )}
      <div className="bd-badges">
        {card.usingSample && !props.sampleOutside && <SampleBadge />}
        {card.problem !== null && (
          <span className="bd-badge warn" title={`${dataProblemText(t, card.problem, PANEL_DATA_MAX_BYTES)}${card.shown.kind === "ready" ? ` ${t.showingLast}` : ""}`}>
            <Icon name="triangle-alert" size={11} strokeWidth={1.8} />
            {t.dataProblemShort}
          </span>
        )}
      </div>
    </div>
  );
}

/** 「样例」标：这张卡显示的是插件自带的样例数据，不是真数据。 */
function SampleBadge() {
  const t = useT().pluginPanel;
  return (
    <span className="bd-badge" title={t.sampleTip}>
      <Icon name="flask-conical" size={11} strokeWidth={1.8} />
      {t.sample}
    </span>
  );
}

/** 当前主题的计算值，随主题 / 字号基准的变化更新（变了才换引用，避免重复下发）。 */
export function usePanelTheme(): PanelTheme {
  const [theme, setTheme] = useState(() => readPanelTheme(document.documentElement));
  useEffect(() => {
    const root = document.documentElement;
    const update = (): void =>
      setTheme((previous) => {
        const next = readPanelTheme(root);
        return sameTheme(previous, next) ? previous : next;
      });
    update();
    const observer = new MutationObserver(update);
    // data-theme 是主题；style 是 --ui-font-size 等运行时覆盖；lang 随主题切换一起变（纸面主题换字体）
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "style", "class", "lang"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
