/**
 * 右栏里的插件面板：一只沙箱 iframe 装着插件的模板，宿主只做四件事——
 * 把数据与主题发进去、收模板的 `orbita:ready` / `orbita:action`、说明数据读不出来的原因、反馈「已记下」。
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
import { useCallback, useEffect, useRef, useState } from "react";
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
  type PluginPanelTab,
} from "@shared/plugin-panel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelIconButton, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
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

export function PluginPanel(props: { tab: PluginPanelTab; workspaceId: string | null }) {
  const t = useT().pluginPanel;
  const { tab } = props;
  const feed = usePanelFeed(tab.name, props.workspaceId);
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

  // 换了面板：回到面板视图（原始数据视图是上一个面板的）
  useEffect(() => {
    setRaw(false);
  }, [tab.name]);

  const title = feed.kind === "ready" ? feed.title : tab.title;
  const header = (
    <div className="cap-review-head">
      <PanelTitle icon="layout-grid" title={title} className="cap-slot-left" />
      <div className="cap-slot-right">
        {feed.kind === "ready" && (
          <PanelIconButton title={raw ? t.backToPanel : t.rawData} onClick={() => setRaw((on) => !on)}>
            <Icon name={raw ? "layout-grid" : "file-json-2"} size={16} strokeWidth={1.8} />
          </PanelIconButton>
        )}
      </div>
    </div>
  );

  return (
    <RightPanelFrame header={header} contentKey={`plugin-panel:${tab.name}`}>
      <div className="pp">
        <PanelBody feed={feed} name={tab.name} theme={theme} raw={raw} onNotify={notify} />
        <div className="pp-toast-slot" role="status" aria-live="polite">
          {toast !== null && (
            <span key={toast.id} className="pp-toast" data-tone={toast.tone}>
              <Icon name={toast.tone === "ok" ? "check" : "triangle-alert"} size={13} strokeWidth={2} />
              {toast.text}
            </span>
          )}
        </div>
      </div>
    </RightPanelFrame>
  );
}

function PanelBody(props: {
  feed: PanelFeed;
  name: string;
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
    return (
      <div className="pp-note" role="alert">
        <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
        <div className="pp-note-body">
          <b>{t.unavailableTitle}</b>
          <span>{t.unavailable[feed.reason]}</span>
          {feed.problems.map((problem, index) => (
            <span key={index}>{panelProblemText(t, problem)}</span>
          ))}
          <span className="pp-note-hint">{t.unavailableHint}</span>
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
          name={props.name}
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
  name: string;
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

  const { name, onNotify } = props;
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
      // 只做一件事：交给主进程追加进 actions.jsonl。宿主不据此执行任何别的
      api.plugin
        .panelAction({ name, action: checked.action, payload: checked.payload })
        .then((result) => onNotify(result.ok ? t.recorded : t.recordFailed(actionFailureText(t, result.reason)), result.ok ? "ok" : "warn"))
        .catch((cause: unknown) => onNotify(t.recordFailed(cause instanceof Error ? cause.message : String(cause)), "warn"));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [name, onNotify, t]);

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
