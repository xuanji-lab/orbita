/**
 * 插件面板：一只沙箱 iframe 装着插件的模板，宿主只做四件事——
 * 把数据与主题发进去、收模板的 `orbita:ready` / `orbita:action`、说明数据读不出来的原因、反馈「已记下」。
 * 它住在两个地方：插件详情的「面板」页签（已装的插件），和右栏插件页的「正在做」视图（还没安装的草稿）。
 * 本文件只出面板本体（条 + iframe + 模板说明），外壳（页签 / 右栏胶囊）由调用方给。
 *
 * **模板是不可信代码**（见 shared/plugin-panel.ts 与 main/plugin/panel-frame.ts）：
 * - iframe `sandbox="allow-scripts"`，**不给** allow-same-origin / allow-top-navigation / allow-popups /
 *   allow-forms：模板拿不到我们的 DOM、window.top、Electron 与 preload，也开不了窗、跳不了顶层；
 * - 文档来自 `orbita-panel://` 协议，CSP 在响应头（不能联网、不能引外部资源）；
 * - 收消息只认**这只 iframe 的 contentWindow**，且来源必须是 `"null"`（沙箱不透明来源）——别的窗口、
 *   别的 iframe、拿到我们 window 引用的东西发来的一律丢掉；
 * - 往里发消息的 targetOrigin 只能是 `"*"`（不透明来源没有可写的 origin），所以发出去的内容只有
 *   数据与主题——都是模板本来就该看到的，不含任何会话内容、路径之外的本机信息、密钥。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
} from "@shared/plugin-panel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";
import { actionFailureText, dataProblemText, panelProblemText, rawDataText, readPanelTheme, sameTheme, showHostEmpty } from "./panel-view.ts";
import { usePanelFeed, type PanelFeed } from "./usePluginPanel.ts";
import "./plugin-panel.css";

/** load 之后给模板发 ready 的时间；过了它还没有 ready 才由宿主盖「还没有产出」（别先闪一下再被换掉）。 */
const EMPTY_GRACE_MS = 400;
const TOAST_MS = 1800;

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "warn";
}

/** 详情页「面板」页签里的面板：已装的插件，按名字轮询。 */
export function InstalledPanel(props: { name: string; workspaceId: string | null; extra?: ReactNode }) {
  const feed = usePanelFeed({ kind: "installed", name: props.name, workspaceId: props.workspaceId });
  return <PluginPanelView key={props.name} feed={feed} actionName={props.name} draft={false} specOpen={false} extra={props.extra} />;
}

/**
 * 面板本体：顶上一条小工具条（样例标记、原始数据、调用方给的额外动作），中间是模板，底下是模板说明。
 * 高度由调用方给（父级是定高的 flex 列）：模板拿满剩下的，说明最多占四成、自己滚。
 * 换了面板由调用方换 `key`（原始数据视图、说明的开合都是这个面板自己的）。
 */
export function PluginPanelView(props: {
  feed: PanelFeed;
  /** 动作要写进哪个插件的 actions.jsonl；草稿预览为 null（不记录） */
  actionName: string | null;
  /**
   * 草稿预览：插件还没装，没有数据目录可记——模板里点的按钮只提示「预览里不记录」，不写任何文件。
   * 同时：模板说明的占位卡常驻（它是在和用户商量的东西），还没有面板说「还没有」而不是报错。
   */
  draft: boolean;
  /** 模板说明默认是不是展开 */
  specOpen: boolean;
  /** 工具条最右的额外动作（详情页的「在右栏打开」） */
  extra?: ReactNode;
}) {
  const t = useT().pluginPanel;
  const { feed, actionName } = props;
  const theme = usePanelTheme();
  const [raw, setRaw] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastId = useRef(0);

  // 「已记下」很轻：右下角一枚小胶囊，1.8 秒自己消失；失败用警示色并说原因
  const notify = useCallback((text: string, tone: Toast["tone"]) => {
    toastId.current += 1;
    setToast({ id: toastId.current, text, tone });
  }, []);
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <div className="pp pp-tab">
      {feed.kind === "ready" && (
        <div className="pp-strip">
          {feed.usingSample && (
            <span className="pp-sample" title={t.sampleTip}>
              <Icon name="flask-conical" size={12} strokeWidth={1.8} />
              {t.sample}
            </span>
          )}
          {feed.usingSample && <span className="pp-strip-hint">{t.sampleHint}</span>}
          <span className="pp-strip-grow" />
          {/* 只放图标：窄栏里文字按钮会把左边那句话挤没；名字在 title 与读屏标签里 */}
          <button
            type="button"
            className="pl-btn pp-mini icon"
            aria-pressed={raw}
            aria-label={raw ? t.backToPanel : t.rawData}
            title={raw ? t.backToPanel : t.rawData}
            onClick={() => setRaw((on) => !on)}
          >
            <Icon name={raw ? "layout-grid" : "file-json-2"} size={13} strokeWidth={1.8} />
          </button>
          {props.extra}
        </div>
      )}
      {feed.kind === "ready" &&
        feed.notices.map((problem, index) => (
          <div className="pp-note pp-bar" role="status" key={index}>
            <Icon name="info" size={14} strokeWidth={1.8} />
            <div className="pp-note-body">
              <span>{panelProblemText(t, problem)}</span>
            </div>
          </div>
        ))}
      <PanelBody feed={feed} actionName={actionName} draft={props.draft} theme={theme} raw={raw} onNotify={notify} />
      {(feed.kind === "ready" || props.draft) && (
        <PanelSpec
          // 说明从无到有：重新按默认开合（草稿里 agent 刚写好说明，要让人看见）
          key={feed.kind === "ready" && feed.spec !== null ? "has" : "none"}
          text={feed.kind === "ready" ? feed.spec : null}
          draft={props.draft}
          defaultOpen={props.specOpen}
        />
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

/** 模板说明：宿主渲染的 markdown（不进 iframe），可折叠。草稿里没有说明时给一张占位，让人知道它还没写。 */
function PanelSpec(props: { text: string | null; draft: boolean; defaultOpen: boolean }) {
  const t = useT().pluginPanel;
  const [open, setOpen] = useState(props.defaultOpen);
  if (props.text === null && !props.draft) return null;
  return (
    <section className="pp-spec" data-open={open}>
      <button type="button" className="pp-spec-h" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} strokeWidth={1.8} />
        <Icon name="list-todo" size={14} strokeWidth={1.8} />
        <b>{props.draft ? t.specDraftTitle : t.specTitle}</b>
        {props.draft && <span className="pp-spec-badge">{t.specDraftBadge}</span>}
      </button>
      {open && (
        <div className="pp-spec-body scroll">
          {props.text === null ? <p className="pl-muted">{t.specDraftEmpty}</p> : <MarkdownBlock text={props.text} />}
        </div>
      )}
    </section>
  );
}

function PanelBody(props: {
  feed: PanelFeed;
  /** 动作要写进哪个插件的 actions.jsonl；草稿预览为 null（不记录） */
  actionName: string | null;
  draft: boolean;
  theme: PanelTheme;
  raw: boolean;
  onNotify: (text: string, tone: Toast["tone"]) => void;
}) {
  const t = useT().pluginPanel;
  const { feed } = props;
  if (feed.kind === "loading") return <p className="panel-empty">{t.loading}</p>;
  if (feed.kind === "error") {
    return (
      <p className="panel-empty" role="alert" data-tone="danger">
        {feed.message}
      </p>
    );
  }
  if (feed.kind === "unavailable") {
    // 草稿还没写出面板是常态（agent 正在做）：不是出错，说「还没有」并告诉用户它会自己出现
    if (props.draft && feed.reason === "no-panel") {
      return (
        <div className="pp-wait" role="status">
          <Icon name="circle-dashed" size={22} strokeWidth={1.6} />
          <b>{t.draftNoPanelTitle}</b>
          <span>{t.draftNoPanelHint}</span>
        </div>
      );
    }
    return (
      <div className="pp-note" role="alert">
        <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
        <div className="pp-note-body">
          <b>{t.unavailableTitle}</b>
          <span>{t.unavailable[feed.reason]}</span>
          {feed.problems.map((problem, index) => (
            <span key={index}>{panelProblemText(t, problem)}</span>
          ))}
          {!props.draft && <span className="pp-note-hint">{t.unavailableHint}</span>}
        </div>
      </div>
    );
  }
  return (
    <>
      {feed.problem !== null && <DataProblemBar problem={feed.problem} keepingLast={feed.shown.kind === "ready"} />}
      {props.raw ? (
        <RawData data={feed.shown} />
      ) : (
        // key：模板换了就整只重建，里面的 loaded / ready 状态跟着清零
        <PanelFrame
          key={feed.frameKey}
          actionName={props.actionName}
          title={feed.title}
          frameUrl={feed.frameUrl}
          shown={feed.shown}
          problem={feed.problem}
          theme={props.theme}
          onNotify={props.onNotify}
        />
      )}
    </>
  );
}

function DataProblemBar(props: { problem: PluginPanelDataProblem; keepingLast: boolean }) {
  const t = useT().pluginPanel;
  return (
    <div className="pp-note pp-bar" role="alert">
      <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
      <div className="pp-note-body">
        <span>{dataProblemText(t, props.problem, PANEL_DATA_MAX_BYTES)}</span>
        {props.keepingLast && <span className="pp-note-hint">{t.showingLast}</span>}
      </div>
    </div>
  );
}

function RawData(props: { data: PluginPanelData }) {
  const t = useT().pluginPanel;
  const { text, truncated } = rawDataText(props.data);
  if (text === "") return <p className="panel-empty">{t.rawEmpty}</p>;
  return (
    <div className="pp-raw-wrap">
      <pre className="pp-raw">{text}</pre>
      {truncated && <p className="pp-note-hint">{t.rawTruncated}</p>}
    </div>
  );
}

function PanelFrame(props: {
  actionName: string | null;
  title: string;
  frameUrl: string;
  shown: PluginPanelData;
  problem: PluginPanelDataProblem | null;
  theme: PanelTheme;
  onNotify: (text: string, tone: Toast["tone"]) => void;
}) {
  const t = useT().pluginPanel;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [templateHandlesEmpty, setTemplateHandlesEmpty] = useState(false);
  const [graceOver, setGraceOver] = useState(false);

  const post = useCallback((): void => {
    const target = frame.current?.contentWindow;
    if (target === null || target === undefined) return;
    const message: PanelDataMessage = { type: "orbita:data", ...dataMessageParts(props.shown), theme: props.theme };
    // 沙箱 iframe 的来源是不透明的，没有可写的 targetOrigin；我们只往自己手里这只 iframe 的 window 发
    target.postMessage(message, "*");
  }, [props.shown, props.theme]);
  const postRef = useRef(post);
  postRef.current = post;

  // 宿主在 iframe load 后主动发一次数据，不等模板的 ready——模板不发 ready 也看得到数据；
  // 数据或主题变了再发一次（post 的依赖就是它们）
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

  const { actionName, onNotify } = props;
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
      // 只做一件事：交给主进程追加进 actions.jsonl。宿主不据此执行任何别的
      api.plugin
        .panelAction({ name: actionName, action: checked.action, payload: checked.payload })
        .then((result) => onNotify(result.ok ? t.recorded : t.recordFailed(actionFailureText(t, result.reason)), result.ok ? "ok" : "warn"))
        .catch((cause: unknown) => onNotify(t.recordFailed(cause instanceof Error ? cause.message : String(cause)), "warn"));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [actionName, onNotify, t]);

  const hostEmpty = showHostEmpty({ shown: props.shown, problem: props.problem, templateHandlesEmpty, graceOver });
  return (
    <div className="pp-frame-wrap">
      <iframe
        ref={frame}
        className="pp-frame"
        title={props.title}
        src={props.frameUrl}
        // 只给脚本。不给 allow-same-origin（否则 srcdoc / 同源即可摸到我们的 DOM 与 preload）、
        // allow-top-navigation / allow-popups / allow-forms / allow-modals / allow-downloads
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        style={{ visibility: hostEmpty ? "hidden" : "visible" }}
        onLoad={() => setLoaded(true)}
      />
      {hostEmpty && (
        <div className="pp-empty">
          <Icon name="circle-dashed" size={24} strokeWidth={1.6} />
          <b>{t.noOutput}</b>
          <span>{t.noOutputHint}</span>
        </div>
      )}
    </div>
  );
}

/** 当前主题的计算值，随主题 / 字号基准的变化更新（变了才换引用，避免重复下发）。 */
function usePanelTheme(): PanelTheme {
  const [theme, setTheme] = useState(() => readPanelTheme(document.documentElement));
  useEffect(() => {
    const root = document.documentElement;
    const update = (): void => setTheme((previous) => {
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
