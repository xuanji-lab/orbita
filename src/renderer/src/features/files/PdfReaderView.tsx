import { useContext, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { Menu, type MenuItem } from "../../shell/Menu";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { ColorButton } from "../slides-editor/FormatBar";
import { PreviewNotice } from "./PreviewChrome";
import { api } from "../../api";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { LocaleContext, useT } from "../../locale.ts";
import { citeRectsForReader } from "./pdf-cite-rects.ts";
import {
  acceptReaderMessage,
  blockedMessage,
  isNarrowReader,
  isOpenableLink,
  pendingAfterDelete,
  pendingAfterSave,
} from "./pdf-reader-view.ts";
import type { PdfJump } from "./PdfView";
import "./pdf-reader.css";
import type { FileListRequest } from "@shared/files";
import {
  PDF_READER_ORIGIN,
  PDF_READER_PAGE_URL,
  READER_COLORS,
  readerColorScheme,
  readerLocale,
  type PdfReaderOpenResult,
  type ReaderAnnotation,
  type ReaderCommand,
  type ReaderTool,
} from "@shared/pdf-reader";

type OpenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "unavailable"; detail: string }
  | { status: "ready"; doc: Extract<PdfReaderOpenResult, { kind: "ready" }> };

interface ViewState {
  pageIndex: number;
  pageLabel: string;
  pagesCount: number;
  sidebarOpen: boolean;
  tool: ReaderTool;
  color: string;
}

const TOOL_ICON: Record<ReaderTool, IconName> = {
  pointer: "mouse-pointer-2",
  highlight: "highlighter",
  underline: "underline",
  note: "sticky-note",
  text: "type",
  image: "square-dashed",
  ink: "pen-line",
  eraser: "eraser",
};
/** 工具栏上平铺的三个（最常用）；其余进「批注工具」菜单 */
const INLINE_TOOLS: readonly ReaderTool[] = ["highlight", "underline", "note"];
const MENU_TOOLS: readonly ReaderTool[] = ["text", "image", "ink", "eraser"];

/** 解析后的主题跟着 `<html data-theme>` 走（useTheme 写在那里），不从 App 一层层传 */
function useResolvedTheme(): string | undefined {
  const [theme, setTheme] = useState(() => document.documentElement.dataset["theme"]);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(root.dataset["theme"]));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * PDF 阅读器（实验功能「PDF 阅读器」）：右侧文件面板里，用 zotero/reader 的 web 版读 PDF、划高亮、写批注。
 *
 * **半屏外壳是我们自己的**：阅读器为整屏设计，自带的工具栏藏掉（host.css），这里画一条紧凑工具栏驱动它
 * （照文档面板 `.dp-bar` 的做法：单行不折行，按容器宽度逐级收进「…」）；批注栏在窄面板（< 920px）里浮在页面上、
 * 默认收起，宽面板里并排、默认展开；页面始终适宽。
 *
 * **批注**：阅读器的存 / 删回调经桥脚本发来，这里转给主进程写进 PDF 旁边的数据文件；写失败时提示 + 重试，
 * 未落盘的批注记在内存里（重试时一次补齐）。一次删多条要确认时，用面板里的一条提示带（不是系统对话框）。
 *
 * 换文件 / 换语言：iframe 按 token + 语言重建（阅读器是全局单例，一个 iframe 只开一篇）。
 */
export function PdfReaderView(props: {
  request: FileListRequest;
  jump: PdfJump | null;
  reloadToken: number;
  /** 阅读器产物缺失时的出口：这个标签改用简单预览 */
  onFallback: () => void;
}) {
  const t = useT();
  const tr = t.files.reader;
  const { request, jump } = props;
  const locale = readerLocale(useContext(LocaleContext));
  const theme = useResolvedTheme();
  const [open, setOpen] = useState<OpenState>({ status: "loading" });
  const [view, setView] = useState<ViewState | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [narrow, setNarrow] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState<{ id: number; count: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [missing, setMissing] = useState<number | null>(null);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  /** 出错态里「重试」：同一份文件整份重开 */
  const [retry, setRetry] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef(new Map<string, ReaderAnnotation>());
  const narrowRef = useRef<boolean | null>(null);
  narrowRef.current = narrow;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const token = open.status === "ready" ? open.doc.token : null;

  // 打开：过主进程白名单，拿 token 与批注。换文件 / 刷新整份重来；卸载或被顶掉时作废 token
  useEffect(() => {
    let alive = true;
    let opened: string | null = null;
    setOpen({ status: "loading" });
    setView(null);
    setInitialized(false);
    setSaveError(null);
    setConfirm(null);
    pendingRef.current = new Map();
    api.pdfReader
      .open(request)
      .then((result) => {
        if (result.kind === "ready") opened = result.token;
        if (!alive) {
          if (opened !== null) void api.pdfReader.close(opened);
          return;
        }
        setOpen(result.kind === "ready" ? { status: "ready", doc: result } : { status: "unavailable", detail: result.detail });
      })
      .catch((cause: unknown) => {
        if (alive) setOpen({ status: "error", message: ipcErrorText(cause) });
      });
    return () => {
      alive = false;
      if (opened !== null) void api.pdfReader.close(opened);
    };
    // request 每次渲染都是新对象：按它的字段判变化。换语言也整份重开：阅读器只在创建时收 ftl，新 iframe 要重新
    // 走一遍就绪 → init → layout / 深浅（只换 iframe 的 key 不重置 initialized 的话，新页面收不到这几条命令）
  }, [request.sessionId, request.workspaceId, request.root, request.dir, props.reloadToken, locale, retry]);

  const send = (command: ReaderCommand): void => {
    frameRef.current?.contentWindow?.postMessage(command, PDF_READER_ORIGIN);
  };

  // 面板宽度 → 并排 / 浮层
  useEffect(() => {
    const node = rootRef.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setNarrow(isNarrowReader(width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open.status]);
  useEffect(() => {
    if (narrow !== null && initialized) send({ type: "layout", narrow });
  }, [narrow, initialized]);

  // 深浅跟着 Orbita 的主题立即切
  useEffect(() => {
    if (initialized) send({ type: "color-scheme", value: readerColorScheme(theme) });
  }, [theme, initialized]);

  const save = (annotations: ReaderAnnotation[]): void => {
    if (token === null || annotations.length === 0) return;
    void api.pdfReader
      .save({ token, annotations })
      .then((result) => {
        if (result.ok) {
          pendingRef.current = pendingAfterDelete(pendingRef.current, annotations.map((item) => item.id));
          if (pendingRef.current.size === 0) setSaveError(null);
        } else if (result.reason !== "expired") {
          pendingRef.current = pendingAfterSave(pendingRef.current, annotations);
          setSaveError(result.message);
        }
      })
      .catch((cause: unknown) => {
        pendingRef.current = pendingAfterSave(pendingRef.current, annotations);
        setSaveError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const remove = (ids: string[]): void => {
    if (token === null || ids.length === 0) return;
    pendingRef.current = pendingAfterDelete(pendingRef.current, ids);
    void api.pdfReader
      .remove({ token, ids })
      .then((result) => {
        if (!result.ok && result.reason !== "expired") setSaveError(result.message);
      })
      .catch((cause: unknown) => setSaveError(cause instanceof Error ? cause.message : String(cause)));
  };

  // 阅读器页面发来的消息
  useEffect(() => {
    if (open.status !== "ready") return;
    const doc = open.doc;
    const onMessage = (event: MessageEvent): void => {
      const message = acceptReaderMessage(event, frameRef.current?.contentWindow);
      if (message === null) return;
      switch (message.type) {
        case "ready":
          send({
            type: "init",
            docUrl: doc.docUrl,
            annotations: doc.annotations,
            colorScheme: readerColorScheme(themeRef.current),
            locale,
            sidebarOpen: narrowRef.current === false,
            readOnly: doc.blocked !== null,
          });
          return;
        case "initialized":
          setInitialized(true);
          return;
        case "state":
          setView({
            pageIndex: message.pageIndex,
            pageLabel: message.pageLabel,
            pagesCount: message.pagesCount,
            sidebarOpen: message.sidebarOpen,
            tool: message.tool,
            color: message.color,
          });
          return;
        case "save":
          save(message.annotations);
          return;
        case "delete":
          remove(message.ids);
          return;
        case "confirm":
          setConfirm({ id: message.id, count: message.count });
          return;
        case "open-link":
          if (isOpenableLink(message.url)) window.open(message.url, "_blank", "noopener");
          return;
        case "error":
          console.warn("[pdf-reader]", message.message);
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, locale]);

  // 引用跳转：用我们的 pdf.js 把引文换成页内矩形，交给阅读器滚过去并闪一下
  useEffect(() => {
    if (jump === null || !initialized) return;
    let alive = true;
    setMissing(null);
    void citeRectsForReader(request, jump.citation)
      .then((position) => {
        if (!alive) return;
        if (position === null) {
          setMissing(jump.citation.page);
          send({ type: "go-to-page", label: String(jump.citation.page) });
          return;
        }
        send({ type: "navigate", pageIndex: position.pageIndex, rects: position.rects });
      })
      .catch(() => {
        if (alive) setMissing(jump.citation.page);
      });
    return () => {
      alive = false;
    };
  }, [jump?.token, initialized]);

  if (open.status === "loading") {
    return (
      <div className="pdr-state file-preview-loading">
        <Icon name="loader-circle" size={14} spin />
        {t.common.loading}
      </div>
    );
  }
  if (open.status === "error") {
    return (
      <div className="pdr-state file-preview-error">
        <PanelLine danger>{tr.failed(open.message)}</PanelLine>
        <PanelButton onClick={() => setRetry((n) => n + 1)}>{t.common.retry}</PanelButton>
      </div>
    );
  }
  if (open.status === "unavailable") {
    return (
      <div className="pdr-state file-preview-empty">
        <Icon name="triangle-alert" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{tr.unavailable}</PanelLine>
        <PanelLine>{open.detail}</PanelLine>
        <PanelButton onClick={props.onFallback}>{tr.useSimplePreview}</PanelButton>
      </div>
    );
  }

  const doc = open.doc;
  const readOnly = doc.blocked !== null;
  const ready = initialized && view !== null;
  const toolItem = (tool: ReaderTool): MenuItem => ({
    id: tool,
    label: tr.tool[tool],
    icon: TOOL_ICON[tool],
    checked: view?.tool === tool,
    onSelect: () => send({ type: "tool", tool: view?.tool === tool ? "pointer" : tool }),
  });
  const zoomItems: MenuItem[] = [
    { id: "zoom-out", label: tr.zoomOut, icon: "zoom-out", onSelect: () => send({ type: "zoom", action: "out" }) },
    { id: "zoom-in", label: tr.zoomIn, icon: "zoom-in", onSelect: () => send({ type: "zoom", action: "in" }) },
    { id: "fit", label: tr.fitWidth, icon: "move-horizontal", onSelect: () => send({ type: "zoom", action: "page-width" }) },
  ];
  const menuTools = MENU_TOOLS.map(toolItem);
  const goToPage = (): void => {
    if (pageDraft !== null && pageDraft.trim() !== "") send({ type: "go-to-page", label: pageDraft.trim() });
    setPageDraft(null);
  };

  return (
    <div className="pdr" ref={rootRef} data-narrow={narrow === true ? "true" : undefined}>
      <div className="pdr-bar" role="toolbar" aria-label={tr.toolbar}>
        <IconButton
          label={view?.sidebarOpen === true ? tr.hideSidebar : tr.showSidebar}
          size={28}
          active={view?.sidebarOpen === true}
          disabled={!ready}
          onClick={() => send({ type: "sidebar", open: view?.sidebarOpen !== true })}
        >
          <Icon name="panel-left" size={16} strokeWidth={1.8} />
        </IconButton>
        <span className="dp-bar-rule" aria-hidden="true" />
        <IconButton label={tr.prevPage} size={28} disabled={!ready || view === null || view.pageIndex <= 0} onClick={() => send({ type: "page", action: "prev" })}>
          <Icon name="chevron-up" size={16} strokeWidth={1.8} />
        </IconButton>
        <span className="pdr-page">
          <input
            className="pdr-page-input"
            aria-label={tr.pageInput}
            disabled={!ready}
            value={pageDraft ?? view?.pageLabel ?? ""}
            onChange={(event) => setPageDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={goToPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setPageDraft(null);
                event.currentTarget.blur();
              }
            }}
          />
          <span className="pdr-page-count">{tr.pageCount(view?.pagesCount ?? 0)}</span>
        </span>
        <IconButton
          label={tr.nextPage}
          size={28}
          disabled={!ready || view === null || view.pageIndex >= view.pagesCount - 1}
          onClick={() => send({ type: "page", action: "next" })}
        >
          <Icon name="chevron-down" size={16} strokeWidth={1.8} />
        </IconButton>
        {!readOnly && (
          <>
            <span className="dp-bar-rule" aria-hidden="true" />
            <span className="pdr-tools">
              {INLINE_TOOLS.map((tool) => (
                <IconButton
                  key={tool}
                  label={tr.tool[tool]}
                  size={28}
                  active={view?.tool === tool}
                  disabled={!ready}
                  onClick={() => send({ type: "tool", tool: view?.tool === tool ? "pointer" : tool })}
                >
                  <Icon name={TOOL_ICON[tool]} size={16} strokeWidth={1.8} />
                </IconButton>
              ))}
            </span>
            <Menu
              items={[...INLINE_TOOLS.map(toolItem), ...menuTools]}
              trigger={({ open: menuOpen, toggle }) => (
                <span className="pdr-tools-all">
                  <IconButton label={tr.tools} size={28} ariaExpanded={menuOpen} active={view !== null && view.tool !== "pointer"} disabled={!ready} onClick={toggle}>
                    <Icon name={view === null || view.tool === "pointer" ? "highlighter" : TOOL_ICON[view.tool]} size={16} strokeWidth={1.8} />
                  </IconButton>
                </span>
              )}
            />
            <Menu
              items={menuTools}
              trigger={({ open: menuOpen, toggle }) => (
                <span className="pdr-tools-more">
                  <IconButton
                    label={tr.tools}
                    size={28}
                    ariaExpanded={menuOpen}
                    active={view !== null && MENU_TOOLS.includes(view.tool)}
                    disabled={!ready}
                    onClick={toggle}
                  >
                    <Icon name={view !== null && MENU_TOOLS.includes(view.tool) ? TOOL_ICON[view.tool] : "pen-line"} size={16} strokeWidth={1.8} />
                  </IconButton>
                </span>
              )}
            />
            <ColorButton
              label={tr.color}
              value={view?.color ?? READER_COLORS[0].value}
              palette={READER_COLORS.map((color) => color.value)}
              onPick={(color) => send({ type: "tool", tool: view === null || view.tool === "pointer" ? "highlight" : view.tool, color })}
            />
          </>
        )}
        <span className="dp-bar-grow" />
        <span className="pdr-zoom">
          <IconButton label={tr.zoomOut} size={28} disabled={!ready} onClick={() => send({ type: "zoom", action: "out" })}>
            <Icon name="zoom-out" size={16} strokeWidth={1.8} />
          </IconButton>
          <IconButton label={tr.zoomIn} size={28} disabled={!ready} onClick={() => send({ type: "zoom", action: "in" })}>
            <Icon name="zoom-in" size={16} strokeWidth={1.8} />
          </IconButton>
          <IconButton label={tr.fitWidth} size={28} disabled={!ready} onClick={() => send({ type: "zoom", action: "page-width" })}>
            <Icon name="move-horizontal" size={16} strokeWidth={1.8} />
          </IconButton>
        </span>
        <IconButton label={tr.find} size={28} disabled={!ready} onClick={() => send({ type: "find" })}>
          <Icon name="search" size={16} strokeWidth={1.8} />
        </IconButton>
        <span className="pdr-more">
          <Menu
            items={zoomItems}
            align="end"
            trigger={({ open: menuOpen, toggle }) => (
              <IconButton label={tr.more} size={28} ariaExpanded={menuOpen} disabled={!ready} onClick={toggle}>
                <Icon name="ellipsis-vertical" size={16} strokeWidth={1.8} />
              </IconButton>
            )}
          />
        </span>
      </div>
      {doc.blocked !== null && <PreviewNotice messages={[blockedMessage(doc.blocked, doc.dataFile, tr)]} actions={[]} />}
      {saveError !== null && (
        <PreviewNotice
          messages={[tr.saveFailed(saveError)]}
          actions={[{ label: tr.retrySave, icon: "refresh-cw", onClick: () => save([...pendingRef.current.values()]) }]}
        />
      )}
      {confirm !== null && (
        <PreviewNotice
          messages={[tr.confirmDelete(confirm.count)]}
          actions={[
            {
              label: tr.cancel,
              onClick: () => {
                send({ type: "confirm-result", id: confirm.id, ok: false });
                setConfirm(null);
              },
            },
            {
              label: tr.delete,
              icon: "trash-2",
              onClick: () => {
                send({ type: "confirm-result", id: confirm.id, ok: true });
                setConfirm(null);
              },
            },
          ]}
        />
      )}
      {missing !== null && <PreviewNotice messages={[t.files.citeNotFound(missing)]} actions={[]} />}
      <div className="pdr-stage">
        <iframe
          key={`${doc.token}:${locale}`}
          ref={frameRef}
          className="pdr-frame"
          title={request.dir.split(/[\\/]/).pop() ?? "PDF"}
          src={PDF_READER_PAGE_URL}
          data-ready={ready ? "true" : undefined}
        />
        {!ready && (
          <div className="pdr-loading file-preview-loading">
            <Icon name="loader-circle" size={14} spin />
            {t.common.loading}
          </div>
        )}
      </div>
    </div>
  );
}
