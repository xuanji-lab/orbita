import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { PanelButton, PanelIconButton, PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { MarkdownBlock } from "../chat/MarkdownBlock";
import { highlightBlock, highlighterReady, langFromPath } from "../chat/highlight";
import { fileIcon, formatAge, formatSize } from "./tree-view";
import { HIGHLIGHT_LIMIT, textPreviewMode, truncatedNotice } from "./preview-view";
import { PREVIEW_TEXT_LIMIT, type FilePreview } from "@shared/files";
import { pathTail } from "../../../../shared/path.ts";
import { useT } from "../../locale.ts";

/**
 * 预览面板（分栏模式的右半边，窄屏下独占整个面板宽度——见 FilesPanel.tsx 的
 * `.files-panel-body` container query）。头：返回 / 关闭 + 文件身份 +（md 独有的
 * Rendered/Source）+ 四个动作；体：按 FilePreview 的 kind 与文件名判的排版走
 * markdown 渲染 / 代码高亮 / 等宽原文 / 图片 / 空态。
 *
 * 契约里「怎么排版」不归 shared 管（`shared/files.ts` 顶注释），全部判定逻辑在
 * 这里与 preview-view.ts；这个组件本身不做白名单校验——白名单在主进程，
 * `api.files.read` 传什么 root/dir 都由主进程再核一遍。
 */
export function FilePreviewPane(props: {
  sessionId: string | null;
  workspaceId: string | null;
  root: string;
  /** 文件绝对路径（FilesPanel 的 `preview.path`，同 fs:list 的 dir 语义） */
  path: string;
  /** 窄屏「Back to files」与宽屏「Close preview」是同一个动作——见 FilesPanel 的 Esc 处理 */
  onClose: () => void;
}) {
  const t = useT();
  const { sessionId, workspaceId, root, path, onClose } = props;
  const name = baseName(path);
  const previewMode = textPreviewMode(name);
  const { state, refreshing, refresh } = usePreviewData(sessionId, workspaceId, root, path);
  const loading = state.status === "loading" || refreshing;

  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  // 切文件：Source 模式不带过去，新文件一律先看 Rendered
  useEffect(() => setMode("rendered"), [root, path]);

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyPath = (): void => {
    navigator.clipboard
      .writeText(path)
      .then(() => setCopied(true))
      .catch(() => {
        // 复制失败静默：不是核心路径，剪贴板权限被拒时系统自己会提示
      });
  };

  const openDefault = (): void => {
    void api.files.open({ sessionId, workspaceId, root, dir: path }).catch(() => {
      // 打开失败不单开一条面板错误态——系统对话框已经在说这件事
    });
  };

  const reveal = (): void => {
    void api.files.reveal({ sessionId, workspaceId, root, dir: path }).catch(() => {
      // 同上：Finder 定位失败留给系统层
    });
  };

  // md 文件才有 Rendered/Source；一旦知道读回来的不是文本（binary / too-large）或是
  // 空文件，没有源文本可切，藏起来——避免切换器亮着但切了没反应
  const showModeToggle =
    previewMode === "markdown" &&
    (state.status !== "ready" || (state.data.kind === "text" && state.data.text !== ""));

  return (
    <div className="files-panel-preview">
      <header className="file-preview-header">
        <span className="file-preview-back">
          <PanelIconButton title={t.files.backToFiles} onClick={onClose}>
            <Icon name="arrow-left" size={16} />
          </PanelIconButton>
        </span>
        <span className="file-preview-close">
          <PanelIconButton title={t.files.closePreview} onClick={onClose}>
            <Icon name="x" size={16} />
          </PanelIconButton>
        </span>
        <Icon
          name={fileIcon(name, "file")}
          size={16}
          style={{ color: "var(--color-text-secondary)", flex: "0 0 auto" }}
        />
        <div className="file-preview-title">
          <span className="file-preview-name" title={name}>
            {name}
          </span>
          {state.status === "ready" && (
            <span
              className="file-preview-meta"
              title={t.time.dateTime(state.data.modifiedAt)}
            >
              {formatSize(state.data.size)} · {formatAge(state.data.modifiedAt, Date.now(), t)}
            </span>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <div className="file-preview-actions">
          <PanelIconButton title={t.files.openDefault} onClick={openDefault}>
            <Icon name="external-link" size={16} />
          </PanelIconButton>
          <PanelIconButton title={t.files.revealInFinder} onClick={reveal}>
            <Icon name="folder-open" size={16} />
          </PanelIconButton>
          <PanelIconButton title={copied ? t.chat.copied : t.files.copyPath} onClick={copyPath}>
            <Icon name={copied ? "check" : "copy"} size={16} />
          </PanelIconButton>
          <PanelIconButton title={t.files.refreshPreview} onClick={refresh}>
            <Icon name="refresh-cw" size={16} spin={loading} />
          </PanelIconButton>
        </div>
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
      <div className="file-preview-body">
        <PreviewBody
          name={name}
          mode={mode}
          previewMode={previewMode}
          state={state}
          onRetry={refresh}
          onOpenDefault={openDefault}
        />
      </div>
    </div>
  );
}

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** path 的最后一段（文件名，不含目录）。path 恒非空——FilesPanel 只用真实条目路径构造它 */
function baseName(path: string): string {
  const last = pathTail(path);
  return last === "" ? path : last;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: FilePreview };

/**
 * 预览的数据半边：root/path 变就重拉；`refresh` 重拉同一个。**竞态**：每次发起
 * 请求都领一个递增的 token，回来时比对——快速切两个文件，后发的先回也只有它
 * 的结果会落地，晚到的过期响应被丢弃。
 *
 * 换文件是「硬」加载（正文先换成 Loading…）；refresh 是「软」加载：旧正文留在屏上，
 * 只让头上的刷新图标转，新内容回来原地替换——正文不经过 Loading… 就不会被卸载，
 * 滚动位置得以保留（刷新多半是 agent 刚改了文件、用户正盯着某一段）。
 */
function usePreviewData(
  sessionId: string | null,
  workspaceId: string | null,
  root: string,
  path: string,
): { state: LoadState; refreshing: boolean; refresh: () => void } {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef(0);

  const load = (soft: boolean): void => {
    const id = ++requestRef.current;
    if (soft) {
      setRefreshing(true);
    } else {
      // 硬加载顶掉在途的软加载：它的响应会被 token 丢弃，转圈得在这里停
      setRefreshing(false);
      setState({ status: "loading" });
    }
    api.files
      .read({ sessionId, workspaceId, root, dir: path })
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

  useEffect(() => load(false), [sessionId, workspaceId, root, path]);

  return { state, refreshing, refresh: () => load(true) };
}

/** 体：读取中 / 失败 / 按 kind 与文本形态分派的正文 */
function PreviewBody(props: {
  name: string;
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
  return (
    <>
      {data.truncated && (
        <div className="file-preview-truncated">
          <PanelLine>{truncatedNotice(PREVIEW_TEXT_LIMIT, data.size, t)}</PanelLine>
        </div>
      )}
      <TextBody name={props.name} mode={props.mode} previewMode={props.previewMode} text={data.text} />
    </>
  );
}

/** 三种文本形态的正文：markdown 渲染 / 代码高亮 / 等宽原文；md 的 Source 与超限代码都落等宽原文 */
function TextBody(props: {
  name: string;
  mode: "rendered" | "source";
  previewMode: "markdown" | "code" | "plain";
  text: string;
}) {
  if (props.previewMode === "markdown" && props.mode === "rendered") {
    return <MarkdownBlock text={props.text} variant="full" />;
  }
  if (props.previewMode === "code" && props.text.length <= HIGHLIGHT_LIMIT) {
    return <HighlightedCode name={props.name} text={props.text} />;
  }
  // 超过高亮上限的代码仍按代码排：不折行（与高亮卡片一致，横向滚动），
  // 折行只给 txt / md 源码这类散文式文本
  return (
    <pre className="file-preview-source" data-wrap={props.previewMode === "code" ? "off" : undefined}>
      {props.text}
    </pre>
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

/** binary / too-large / 空文件的空态：一句说明 + 用默认应用打开 */
function EmptyPreview(props: { message: string; onOpenDefault: () => void }) {
  const t = useT();
  return (
    <div className="file-preview-empty">
      <Icon name="file" size={24} style={{ color: "var(--color-text-tertiary)" }} />
      <PanelLine>{props.message}</PanelLine>
      <PanelButton onClick={props.onOpenDefault}>
        <Icon name="external-link" size={14} />
        {t.files.openDefault}
      </PanelButton>
    </div>
  );
}
