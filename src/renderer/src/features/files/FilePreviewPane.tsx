import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { PanelButton, PanelIconButton, PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { MarkdownBlock } from "../chat/MarkdownBlock";
import { highlightBlock, highlighterReady, langFromPath } from "../chat/highlight";
import { fileIcon, formatAge, formatSize } from "./tree-view";
import { crumbSegmentsFromRoot, fileTabName } from "./panel-layout.ts";
import { largeTextNotice, textPreviewMode, textRenderKind } from "./preview-view";
import { WindowedText } from "./WindowedText";
import { RangeTextPreview } from "./RangeTextPreview";
import { EmptyPreview, PreviewNotice } from "./PreviewChrome";
import { isPdfFile, isWebPageFile, type FilePreview } from "@shared/files";
import type { PromptImage } from "@shared/prompt-images";
import { PdfView, type PdfJump } from "./PdfView";
import { useExperimentalFeature } from "../../experimental.ts";
import { useT } from "../../locale.ts";

/**
 * 文件预览面板（标签页模型的标签体：激活哪个标签就渲染哪个文件，见 FilesPanel）。
 * 头按原型简化成**面包屑**——路径分段 + size·mtime，没有返回 / 关闭按钮：标签页
 * 模型下关闭由标签 ✕ 与 Esc 承担（FilesPanel 的 escapeRef 契约不变）。头部动作
 * 只留三个：网页文件进内置浏览器（2026-09-29 裁决，没有第二个入口）、复制路径、
 * 重读文件；「用默认应用打开」与「在文件管理器中显示」各有别的落点（空态按钮 /
 * 树行 hover），头部不再重复。体：按 FilePreview 的 kind 与文件名判的排版走
 * markdown 渲染 / 代码高亮 / 等宽原文 / 图片 / 空态。
 *
 * 契约里「怎么排版」不归 shared 管（`shared/files.ts` 顶注释），全部判定逻辑在
 * 这里与 preview-view.ts；这个组件本身不做白名单校验——白名单在主进程，
 * `api.files.read` 传什么 root/dir 都由主进程再核一遍。
 */
export function FilePreviewPane(props: {
  sessionId: string | null;
  workspaceId: string | null;
  /** 专注 / 浏览态的额外预览根（FilesPanel 递进来，read / open 全带上） */
  extraWorkspaceId?: string | null;
  root: string;
  /** 文件绝对路径（标签的 path，同 fs:list 的 dir 语义）；附图模式下是原图引用 */
  path: string;
  /** 发送附图模式：path 是原图引用，读走 session.attachment（不过 fs:read 白名单），
   * root 不再有意义（标签存的是空串）；name 是合成显示名（image-1.png） */
  sentImage?: { name: string };
  /** 所在根的显示名（面包屑第一段：workspace / attached 的名字、session 的标题） */
  rootLabel: string;
  /** PDF 引用跳转（点了正文里的引用编号）：滚到原文处并高亮。非 PDF / 没有跳转时 null */
  jump?: PdfJump | null;
}) {
  const t = useT();
  const { sessionId, workspaceId, root, path } = props;
  const extraWorkspaceId = props.extraWorkspaceId ?? null;
  const extra = extraWorkspaceId === null ? {} : { extraWorkspaceId };
  const sentImage = props.sentImage;
  // PDF 预览挂在自己的实验开关后面（实验功能「PDF 引用」）：关着时 PDF 照旧读不出
  // 内容（fs:read 只回二进制占位）。附图走 session.attachment，不会是 PDF
  const pdfCitations = useExperimentalFeature("pdf-citations");
  const pdf = sentImage === undefined && pdfCitations && isPdfFile(path);
  const [pdfReload, setPdfReload] = useState(0);
  const name = sentImage?.name ?? fileTabName(path);
  // 面包屑从所在的根开始（绝对路径放不下时截掉的总是末尾的文件名）；完整路径进 tooltip
  const segments =
    sentImage === undefined ? crumbSegmentsFromRoot(root, props.rootLabel, path) : [name];
  const previewMode = sentImage === undefined ? textPreviewMode(name) : "plain";
  const { state, refreshing, refresh } = usePreviewData(
    sentImage === undefined,
    sessionId,
    workspaceId,
    extraWorkspaceId,
    root,
    path,
  );
  const imageState = useSentImage(sentImage !== undefined, path);
  const loading =
    sentImage !== undefined
      ? imageState.status === "loading"
      : state.status === "loading" || refreshing;

  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  // 切文件（标签重挂载或换 path）：Source 模式不带过去，新文件一律先看 Rendered
  useEffect(() => setMode("rendered"), [root, path]);

  const [copied, setCopied] = useState(false);
  // 分段预览（>16 MB）也要能被「刷新」顶一下：文件没变时 mtime 不变，光靠 props 看不出来
  const [textReload, setTextReload] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // 面包屑放不下时从左边裁（保住末尾的文件段）：容器 overflow:hidden 仍可程序滚动，
  // 挂载时一把滚到最右；面板随后拖宽 / 拖窄由浏览器自动夹取 scrollLeft，无需跟踪
  const crumbRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = crumbRef.current;
    if (el !== null) el.scrollLeft = el.scrollWidth;
  }, [segments]);

  // 预览体的滚动容器：窗口化渲染（大文件）要按它的 scrollTop / clientHeight 算窗口
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const copyPath = (): void => {
    navigator.clipboard
      .writeText(path)
      .then(() => setCopied(true))
      .catch(() => {
        // 复制失败静默：不是核心路径，剪贴板权限被拒时系统自己会提示
      });
  };

  const openDefault = (): void => {
    void api.files.open({ sessionId, workspaceId, ...extra, root, dir: path }).catch(() => {
      // 打开失败不单开一条面板错误态——系统对话框已经在说这件事
    });
  };

  // 网页文件的默认打开方式是内置浏览器（2026-09-29 裁决）；附图不是网页文件，
  // 也没有复制路径 / 重读可给（引用不是路径、原图不可变）
  const webPage = sentImage === undefined && isWebPageFile(path);
  const openInBrowser = (): void => {
    void api.files.openInBrowser({ sessionId, workspaceId, ...extra, root, dir: path }).catch(() => {
      // 同 openDefault：失败时浏览器窗口自己显示错误页，面板不另开错误态
    });
  };

  // md 文件才有 Rendered/Source；一旦知道读回来的不是文本（binary / too-large）或是
  // 空文件，没有源文本可切，藏起来——避免切换器亮着但切了没反应；附图没有这一排
  const showModeToggle =
    sentImage === undefined &&
    previewMode === "markdown" &&
    (state.status !== "ready" || (state.data.kind === "text" && state.data.text !== ""));

  return (
    <div className="files-panel-preview">
      <header className="file-preview-header">
        <Icon
          name={fileIcon(name, "file")}
          size={16}
          style={{ color: "var(--color-text-secondary)", flex: "0 0 auto" }}
        />
        {/* 面包屑：从所在的根开始的路径分段 + chevron 分隔；太长时在自身容器里
            **从左边裁**（保住末尾的文件段，激活标签上始终有文件名），完整绝对路径
            在本容器的 title 里；meta 在容器外不受挤 */}
        <div className="file-preview-crumb" ref={crumbRef} title={path}>
          {segments.map((segment, index) => (
            <Fragment key={`${index}:${segment}`}>
              {index > 0 && (
                <Icon
                  name="chevron-right"
                  size={9}
                  strokeWidth={2.4}
                  className="file-preview-crumb-sep"
                />
              )}
              <span
                className={
                  index === segments.length - 1
                    ? "file-preview-crumb-seg cur"
                    : "file-preview-crumb-seg"
                }
              >
                {segment}
              </span>
            </Fragment>
          ))}
        </div>
        {state.status === "ready" && sentImage === undefined && (
          <span
            className="file-preview-meta"
            title={t.time.dateTime(state.data.modifiedAt)}
          >
            {formatSize(state.data.size)} · {formatAge(state.data.modifiedAt, Date.now(), t)}
          </span>
        )}
        {sentImage === undefined && (
          <div className="file-preview-actions">
            {webPage && (
              <PanelIconButton title={t.files.openInBrowser} onClick={openInBrowser}>
                <Icon name="globe" size={16} strokeWidth={1.8} />
              </PanelIconButton>
            )}
            <PanelIconButton title={copied ? t.chat.copied : t.files.copyPath} onClick={copyPath}>
              <Icon name={copied ? "check" : "copy"} size={16} strokeWidth={1.8} />
            </PanelIconButton>
            <PanelIconButton
              title={t.files.refreshPreview}
              onClick={() => {
                refresh();
                if (pdf) setPdfReload((n) => n + 1);
                else setTextReload((n) => n + 1);
              }}
            >
              <Icon name="refresh-cw" size={16} strokeWidth={1.8} spin={loading} />
            </PanelIconButton>
          </div>
        )}
      </header>
      {showModeToggle && (
        <div className="file-preview-mode-row">
          <Chip active={mode === "rendered"} onClick={() => setMode("rendered")}>
            {t.files.rendered}
          </Chip>
          <Chip active={mode === "source"} onClick={() => setMode("source")}>
            {t.files.source}
          </Chip>
        </div>
      )}
      <div className="file-preview-body" data-kind={pdf ? "pdf" : undefined} ref={bodyRef}>
        {pdf ? (
          <PdfView
            request={{ sessionId, workspaceId, ...extra, root, dir: path }}
            jump={props.jump ?? null}
            reloadToken={pdfReload}
          />
        ) : sentImage === undefined ? (
          <PreviewBody
            name={name}
            resetKey={path}
            sessionId={sessionId}
            workspaceId={workspaceId}
            extraWorkspaceId={extraWorkspaceId}
            root={root}
            path={path}
            reloadKey={textReload}
            scroller={bodyRef}
            mode={mode}
            previewMode={previewMode}
            state={state}
            onRetry={refresh}
            onOpenDefault={openDefault}
          />
        ) : imageState.status === "loading" ? (
          <div className="file-preview-loading">
            <Icon name="loader-circle" size={14} spin />
            {t.common.loading}
          </div>
        ) : imageState.status === "gone" ? (
          // 原图不在了（会话目录被清 / 引用落地之前发的图）：转录里还有缩放图可看，
          // 这里不假装能打开——没有可用路径，也不给「用默认应用打开」
          <div className="file-preview-empty">
            <Icon name="image" size={24} style={{ color: "var(--color-text-tertiary)" }} />
            <PanelLine>{t.files.attachmentMissing}</PanelLine>
          </div>
        ) : imageState.status === "ready" ? (
          <div className="file-preview-image-wrap">
            <img
              className="file-preview-image"
              src={`data:${imageState.data.mimeType};base64,${imageState.data.data}`}
              alt={name}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: FilePreview };

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * 预览的数据半边：root/path 变就重拉；`refresh` 重拉同一个。附图模式（enabled=
 * false）不拉也不转——读走 useSentImage，这里静默待命。**竞态**：每次发起
 * 请求都领一个递增的 token，回来时比对——快速切两个文件，后发的先回也只有它
 * 的结果会落地，晚到的过期响应被丢弃。
 *
 * 换文件是「硬」加载（正文先换成 Loading…）；refresh 是「软」加载：旧正文留在屏上，
 * 只让头上的刷新图标转，新内容回来原地替换——正文不经过 Loading… 就不会被卸载，
 * 滚动位置得以保留（刷新多半是 agent 刚改了文件、用户正盯着某一段）。
 */
function usePreviewData(
  enabled: boolean,
  sessionId: string | null,
  workspaceId: string | null,
  extraWorkspaceId: string | null,
  root: string,
  path: string,
): { state: LoadState; refreshing: boolean; refresh: () => void } {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef(0);

  const load = (soft: boolean): void => {
    if (!enabled) return;
    const id = ++requestRef.current;
    if (soft) {
      setRefreshing(true);
    } else {
      // 硬加载顶掉在途的软加载：它的响应会被 token 丢弃，转圈得在这里停
      setRefreshing(false);
      setState({ status: "loading" });
    }
    api.files
      .read({ sessionId, workspaceId, ...(extraWorkspaceId === null ? {} : { extraWorkspaceId }), root, dir: path })
      .then((data) => {
        if (requestRef.current !== id) return;
        setState({ status: "ready", data });
        setRefreshing(false);
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== id) return;
        setState({ status: "error", message: failMessage(cause) });
        setRefreshing(false);
      });
  };

  useEffect(() => load(false), [enabled, sessionId, workspaceId, extraWorkspaceId, root, path]);

  return { state, refreshing, refresh: () => load(true) };
}

type SentImageState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; data: PromptImage }
  | { status: "gone" };

/**
 * 附图预览的数据半边：按原图引用走 `session.attachment`（已有的读原图 IPC，
 * 灯箱同源），不过 fs:read 的白名单。null = 原图不在（目录被清 / 引用落地
 * 之前发的图）→ gone；组件按 key=引用挂载，ref 变 = 换了标签重拉。
 */
function useSentImage(enabled: boolean, ref: string): SentImageState {
  const [state, setState] = useState<SentImageState>({ status: "off" });
  useEffect(() => {
    if (!enabled) {
      setState({ status: "off" });
      return;
    }
    setState({ status: "loading" });
    let alive = true;
    api.session
      .attachment(ref)
      .then((image) => {
        if (!alive) return;
        setState(image === null ? { status: "gone" } : { status: "ready", data: image });
      })
      .catch(() => {
        // 读失败与读不到同样处理：不假装能看
        if (alive) setState({ status: "gone" });
      });
    return () => {
      alive = false;
    };
  }, [enabled, ref]);
  return state;
}

/** 体：读取中 / 失败 / 按 kind 与文本形态分派的正文 */
function PreviewBody(props: {
  name: string;
  /** 换文件时窗口化渲染要重置滚动与窗口（软刷新同文件不重置） */
  resetKey: string;
  sessionId: string | null;
  workspaceId: string | null;
  extraWorkspaceId: string | null;
  root: string;
  path: string;
  /** 「刷新」计数器：分段预览靠它重新索引 */
  reloadKey: number;
  scroller: RefObject<HTMLDivElement | null>;
  mode: "rendered" | "source";
  previewMode: "markdown" | "code" | "plain";
  state: LoadState;
  onRetry: () => void;
  onOpenDefault: () => void;
}) {
  const t = useT();
  const { state } = props;
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
        <PanelButton onClick={props.onRetry}>{t.common.retry}</PanelButton>
      </div>
    );
  }

  const data = state.data;
  if (data.kind === "binary") {
    return <EmptyPreview message={t.files.noPreview} onOpenDefault={props.onOpenDefault} />;
  }
  if (data.kind === "too-large") {
    return (
      <EmptyPreview
        message={t.files.tooLarge(formatSize(data.size), formatSize(data.limit))}
        onOpenDefault={props.onOpenDefault}
      />
    );
  }
  if (data.kind === "image") {
    return (
      <div className="file-preview-image-wrap">
        <img
          className="file-preview-image"
          src={`data:${data.mime};base64,${data.base64}`}
          alt={props.name}
        />
      </div>
    );
  }

  // kind === "text"。空文件（`__init__.py` 这类）不进正文：高亮会画出一张空代码卡，
  // 像是没加载出来——给一句明确的空态
  if (data.text === "") {
    return <EmptyPreview message={t.files.emptyFile} onOpenDefault={props.onOpenDefault} />;
  }
  // > PREVIEW_TEXT_LIMIT：不再只给前 16 MB，改成按行向主进程要窗口（主进程按文件大小
  // 与行数自己决定能不能分段；分段不了它会回长行 / 行数过多的明确结果，由它退回去）
  if (data.truncated) {
    return (
      <RangeTextPreview
        sessionId={props.sessionId}
        workspaceId={props.workspaceId}
        extraWorkspaceId={props.extraWorkspaceId}
        root={props.root}
        path={props.path}
        name={props.name}
        size={data.size}
        modifiedAt={data.modifiedAt}
        headText={data.text}
        scroller={props.scroller}
        resetKey={props.resetKey}
        reloadKey={props.reloadKey}
        onOpenDefault={props.onOpenDefault}
      />
    );
  }
  return (
    <>
      <TextBody
        name={props.name}
        mode={props.mode}
        previewMode={props.previewMode}
        text={data.text}
        size={data.size}
        scroller={props.scroller}
        resetKey={props.resetKey}
        onOpenDefault={props.onOpenDefault}
      />
    </>
  );
}

/**
 * 文本正文的四条路径（判定在 preview-view.ts 的 textRenderKind）：markdown 渲染 /
 * 代码高亮 / 等宽原文 / 窗口化大文本。md 的 Source、超限代码与大文件都落等宽原文。
 *
 * 大文件窗口化时一律不折行、横向滚动——行高必须固定，窗口才算得准（见 WindowedText）。
 */
function TextBody(props: {
  name: string;
  mode: "rendered" | "source";
  previewMode: "markdown" | "code" | "plain";
  text: string;
  /** 文件字节数（提示条上显示的体积要用真实字节，不是字符数） */
  size: number;
  scroller: RefObject<HTMLDivElement | null>;
  resetKey: string;
  /** 大文本提示带尾部的出口（用默认应用打开，与空态同一条 IPC） */
  onOpenDefault: () => void;
}) {
  const t = useT();
  const kind = textRenderKind(props.previewMode, props.mode, props.text.length);
  if (kind === "markdown") {
    return <MarkdownBlock text={props.text} variant="full" />;
  }
  if (kind === "highlight") {
    return <HighlightedCode name={props.name} text={props.text} />;
  }
  // 大文本要说明一声、并给出口（出口与空态那条同一条 IPC）。两条退化路径
  // （小一些的整篇 `<pre>`、大一些的窗口化）共用同一条提示；txt / 代码被窗口化
  // 时排版没变、只是只渲染可见区，也说一句（大文件里看到的可能不是全部）。
  const notice = largeTextNotice(
    props.previewMode,
    props.mode,
    props.text.length,
    props.size,
    t,
  );
  const noticeBar =
    notice === null ? null : (
      <PreviewNotice
        messages={[notice]}
        actions={[{ label: t.files.openDefault, icon: "external-link", onClick: props.onOpenDefault }]}
      />
    );
  if (kind === "windowed") {
    return (
      <>
        {noticeBar}
        <WindowedText text={props.text} scroller={props.scroller} resetKey={props.resetKey} />
      </>
    );
  }
  // 超过高亮上限的代码仍按代码排：不折行（与高亮卡片一致，横向滚动），
  // 折行只给 txt / md 源码这类散文式文本
  return (
    <>
      {noticeBar}
      <pre className="file-preview-source" data-wrap={props.previewMode === "code" ? "off" : undefined}>
        {props.text}
      </pre>
    </>
  );
}

/**
 * 代码高亮：复用聊天 CodeBlock.tsx 的同一套机制（shiki 就绪是异步的，未就绪先
 * 无色渲染；`useMemo` 按 html 字符串稳定 `{ __html }` 对象引用，避免 React 19
 * 按对象身份重写 innerHTML）。包一层 `.chat-md`：`pre.shiki` 的双主题着色
 * （含暗 / 黑主题翻色）就定义在这个作用域下，见 styles.css。
 */
function HighlightedCode(props: { name: string; text: string }) {
  const [, setWarm] = useState(false);
  useEffect(() => {
    void highlighterReady.then(() => setWarm(true));
  }, []);
  const lang = langFromPath(props.name);
  const html = lang === null ? null : highlightBlock(props.text, lang);
  const markup = useMemo(() => (html === null ? null : { __html: html }), [html]);
  if (markup === null) {
    return (
      <pre className="file-preview-source" data-wrap="off">
        {props.text}
      </pre>
    );
  }
  return (
    <div className="chat-md">
      <div dangerouslySetInnerHTML={markup} />
    </div>
  );
}

/**
 * 代码高亮：复用聊天 CodeBlock.tsx 的同一套机制（shiki 就绪是异步的，未就绪先
 * 无色渲染；`useMemo` 按 html 字符串稳定 `{ __html }` 对象引用，避免 React 19
 * 按对象身份重写 innerHTML）。包一层 `.chat-md`：`pre.shiki` 的双主题着色
 * （含暗 / 黑主题翻色）就定义在这个作用域下，见 styles.css。
 */