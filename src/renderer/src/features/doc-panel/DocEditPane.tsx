import { useCallback, useEffect, useRef, useState } from "react";
import type { TextQuote } from "@shared/quote";
import { DOC_GONE, docTitle } from "@shared/doc";
import { isDeckText } from "@shared/doc-slides";
import { isDeckPath } from "@shared/slides";
import { SlidesEditorPane } from "../slides-editor/SlidesEditor";
import { DOC_PAPERS, type DocPaper } from "@shared/settings";
import { api } from "../../api";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { Menu } from "../../shell/Menu";
import { SelectButton } from "../settings/SettingControls";
import { useT } from "../../locale.ts";
import type { ExternalChange } from "./doc-session.ts";
import { useOpenDoc } from "./useOpenDoc.ts";
import { useDocPaper } from "./doc-paper.ts";
import { setOpenDocument } from "./open-document.ts";
import { DocView } from "./DocView";
import { SlidesView } from "./SlidesView";
import { deckHtml, overflowPages, resolvedTokenCss } from "./slide-render";
import { parseDeck } from "@shared/doc-slides";
import type { DocEditorHandle } from "./DocEditor";
import "./doc-panel.css";

/**
 * 文件预览里的「编辑」模式：在右栏文件预览的位置打开一份 `.md` 的编辑器——普通文档是
 * 所见即所得式的文档编辑器，文件头有 `marp: true` 的是演示文稿（缩略条 + 16:9 页 + 页内编辑）。
 * 两者共用这一层：读盘 / 自动保存 / 监听 agent 的改动并最小差异合并（`useOpenDoc` + `DocSession`）、
 * 工具栏、保存状态、纸面切换、导出，以及「此刻开着哪份文件」的登记（发送消息时让模型知道）。
 */
export function DocEditPane(props: DocEditPaneProps) {
  // v2 演示文稿（.slides.json）走新编辑器；.md（文档 / 旧 Marp 演示文稿）走下面这个
  if (isDeckPath(props.path)) {
    return (
      <SlidesEditorPane
        sessionId={props.sessionId}
        workspaceId={props.workspaceId}
        path={props.path}
        {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
        {...(props.onClose === undefined ? {} : { onClose: props.onClose })}
      />
    );
  }
  return <MarkdownEditPane {...props} />;
}

export interface DocEditPaneProps {
  sessionId: string | null;
  workspaceId: string | null;
  /** 文件绝对路径 */
  path: string;
  /** 缺席 = 没有输入框可引（工具栏只剩复制） */
  onQuote?: (quote: TextQuote) => void;
  /** 「关闭」：文件被移走 / 打不开时的出口；缺席 = 不画这个键 */
  onClose?: () => void;
  /** 另存为落在可写根之内时，切过去打开新文件；缺席 = 只提示已另存 */
  onOpenPath?: (path: string) => void;
}

function MarkdownEditPane(props: DocEditPaneProps) {
  const t = useT();
  const { sessionId, workspaceId, path } = props;
  const { paper, locked, setPaper } = useDocPaper();
  // 外部合并结果怎么落进屏幕由具体视图（文档 / 演示文稿）决定，它们把处理函数挂在这里
  const externalRef = useRef<(change: ExternalChange) => void>(() => undefined);
  const docHandle = useRef<DocEditorHandle | null>(null);
  // 文档还是演示文稿：打开时读到的文件头定，编辑期间不变（agent 整份重写丢了 front matter 也不会把视图换掉）
  const [deck, setDeck] = useState(false);
  const doc = useOpenDoc({ sessionId, workspaceId, path }, (change) => externalRef.current(change), deck);
  useEffect(() => {
    if (doc.initial !== null) setDeck(isDeckText(doc.initial.text));
  }, [doc.initial]);

  const ready = doc.phase === "ready" && doc.session !== null && doc.initial !== null;
  useEffect(() => {
    if (!ready) return undefined;
    const session = doc.session;
    if (session === null) return undefined;
    setOpenDocument(
      { path, kind: deck ? "slides" : "doc" },
      { text: () => session.text, trackedRange: (anchor) => docHandle.current?.trackedRange(anchor) ?? null },
    );
    return () => setOpenDocument(null);
  }, [ready, path, deck, doc.session]);

  // 专注写作纸面：打字时工具栏淡出，鼠标一动回来（只改 data-typing，样式在 CSS）
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(typingTimer.current), []);
  const onKeyActivity = (): void => {
    setTyping(true);
    window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setTyping(false), 1600);
  };

  const [note, setNote] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (note === null) return undefined;
    const timer = window.setTimeout(() => setNote(null), note.tone === "danger" ? 10000 : 4000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const saveAs = useCallback(async (): Promise<void> => {
    const session = doc.session;
    if (session === null) return;
    setNote(null);
    try {
      const result = await api.docs.saveAs({ sessionId, workspaceId, path, text: session.text });
      if (result.saved === null) return;
      if (result.inside && props.onOpenPath !== undefined) props.onOpenPath(result.saved);
      else setNote({ text: t.doc.savedAs(result.saved), tone: "ok" });
    } catch (cause) {
      setNote({ text: t.doc.saveAsFailed(ipcErrorText(cause)), tone: "danger" });
    }
  }, [doc.session, sessionId, workspaceId, path, props, t]);

  const [converting, setConverting] = useState(false);
  /** 旧 Marp .md → 新格式（.slides.json，原文件不动），转完切到新文件 */
  const convertDeck = useCallback(async (): Promise<void> => {
    const session = doc.session;
    if (session === null || converting) return;
    setConverting(true);
    setNote(null);
    try {
      await session.flush();
      const converted = await api.docs.convertMarpDeck({ sessionId, workspaceId, path });
      if (props.onOpenPath !== undefined) props.onOpenPath(converted.path);
      else setNote({ text: `${t.slides.newFormat}：${converted.path}`, tone: "ok" });
    } catch (cause) {
      setNote({ text: t.slides.convertFailed(ipcErrorText(cause)), tone: "danger" });
    } finally {
      setConverting(false);
    }
  }, [doc.session, converting, sessionId, workspaceId, path, props, t]);

  const exportNow = useCallback(async (): Promise<void> => {
    const session = doc.session;
    if (session === null || exporting) return;
    setExporting(true);
    setNote(null);
    try {
      // 先把没写的写掉：docx 由主进程读盘转，PDF 用的是这一刻的全文
      await session.flush();
      const target = { sessionId, workspaceId, path };
      const result = deck
        ? await (() => {
            const pages = parseDeck(session.text).pages.map((page) => page.text);
            return api.docs.export({
              ...target,
              format: "pdf",
              html: deckHtml(pages, {
                paper,
                title: docTitle(path),
                // 导出按纸面走，不跟应用的明暗主题：只有「专注写作」的舞台是深底（slide.css 里 light 档的规则）
                theme: "light",
                tokens: resolvedTokenCss("light"),
              }),
              pages: pages.length,
            });
          })()
        : await api.docs.export({ ...target, format: "docx", text: session.text });
      if (result.saved !== null) {
        // 超出 16:9 的页在 PDF 里是被裁掉的：导出完成提示里把页号列出来
        const cut = deck ? overflowPages(parseDeck(session.text).pages.map((page) => page.text), paper) : [];
        setNote(
          cut.length === 0
            ? { text: t.doc.exported(result.saved), tone: "ok" }
            : { text: t.doc.exportedCut(result.saved, cut.join("、")), tone: "danger" },
        );
      }
    } catch (cause) {
      setNote({ text: t.doc.exportFailed(ipcErrorText(cause)), tone: "danger" });
    } finally {
      setExporting(false);
    }
  }, [doc.session, exporting, sessionId, workspaceId, path, deck, paper, t]);

  if (doc.phase === "loading") {
    return (
      <div className="dp" data-paper={paper}>
        <PanelEmpty busy>{t.common.loading}</PanelEmpty>
      </div>
    );
  }
  if (doc.phase === "error" || !ready || doc.session === null || doc.initial === null) {
    const gone = doc.loadError?.startsWith(DOC_GONE) === true;
    return (
      <div className="dp" data-paper={paper}>
        <PanelEmpty
          tone="danger"
          {...(gone || doc.loadError === null ? {} : { hint: doc.loadError })}
          {...(props.onClose === undefined ? {} : { exit: { label: t.doc.closeFile, onClick: props.onClose } })}
        >
          {gone ? t.doc.goneNotice : t.doc.loadFailed}
        </PanelEmpty>
      </div>
    );
  }

  // 工具栏里的状态只放一个短词（长句会把工具栏挤成两行）；原因与出路在下面那条横幅里
  const status =
    doc.state === "error"
      ? t.doc.statusFailed
      : doc.state === "readonly"
        ? t.doc.statusReadonly
        : doc.state === "gone"
          ? t.doc.statusGone
          : doc.state === "saving"
            ? t.doc.saving
            : doc.state === "dirty"
              ? t.doc.dirty
              : t.doc.saved;
  const banner =
    doc.state === "readonly"
      ? { text: t.doc.readonlyNotice, saveAs: true, close: false }
      : doc.state === "gone"
        ? { text: t.doc.goneNotice, saveAs: true, close: true }
        : doc.state === "error"
          ? { text: t.doc.saveFailed(doc.syncError ?? ""), saveAs: false, close: false }
          : null;

  return (
    <div
      className="dp"
      data-paper={paper}
      data-kind={deck ? "slides" : "doc"}
      data-typing={typing ? "true" : undefined}
      onKeyDownCapture={onKeyActivity}
      onMouseMove={() => {
        if (typing) setTyping(false);
      }}
    >
      <div className="dp-bar" role="toolbar" aria-label={t.doc.toolbar}>
        {!deck && (
          <>
            <IconButton label={t.doc.heading} size={28} onClick={() => docHandle.current?.command("heading")}>
              <Icon name="heading" size={16} strokeWidth={1.8} />
            </IconButton>
            <IconButton label={t.doc.bold} size={28} onClick={() => docHandle.current?.command("bold")}>
              <Icon name="bold" size={16} strokeWidth={1.8} />
            </IconButton>
            <IconButton label={t.doc.list} size={28} onClick={() => docHandle.current?.command("list")}>
              <Icon name="list" size={16} strokeWidth={1.8} />
            </IconButton>
            <span className="dp-bar-rule" aria-hidden="true" />
            <IconButton label={t.doc.undo} size={28} onClick={() => docHandle.current?.command("undo")}>
              <Icon name="undo-2" size={16} strokeWidth={1.8} />
            </IconButton>
          </>
        )}
        <span className="dp-bar-grow" />
        <span className="dp-status" data-state={doc.state} role="status" title={doc.syncError ?? undefined}>
          {status}
        </span>
        <Menu
          items={DOC_PAPERS.map((value) => ({
            id: value,
            label: paperName(value, t),
            checked: paper === value,
            onSelect: () => setPaper(value),
          }))}
          align="end"
          trigger={({ open, toggle }) => (
            <SelectButton open={open} onClick={toggle} disabled={locked} title={locked ? t.doc.paperLocked : t.doc.paperLabel}>
              {t.doc.paperLabel}：{paperName(paper, t)}
            </SelectButton>
          )}
        />
        <IconButton
          label={deck ? t.doc.exportPdf : t.doc.exportWord}
          size={28}
          disabled={exporting}
          onClick={() => void exportNow()}
        >
          <Icon name={exporting ? "loader-circle" : "download"} size={16} strokeWidth={1.8} spin={exporting} />
        </IconButton>
      </div>
      {banner !== null && (
        <div className="dp-banner" role="alert">
          <span className="dp-banner-text" title={banner.text}>
            {banner.text}
          </span>
          {banner.saveAs && (
            <button type="button" className="dp-text-action" onClick={() => void saveAs()}>
              {t.doc.saveAs}
            </button>
          )}
          {banner.close && props.onClose !== undefined && (
            <button type="button" className="dp-text-action" onClick={props.onClose}>
              {t.doc.closeFile}
            </button>
          )}
        </div>
      )}
      {deck && (
        <div className="dp-banner" role="status">
          <span className="dp-banner-text" title={t.slides.legacyNotice}>
            {t.slides.legacyNotice}
          </span>
          <button type="button" className="dp-text-action" disabled={converting} onClick={() => void convertDeck()}>
            {converting ? t.slides.converting : t.slides.convertDeck}
          </button>
        </div>
      )}
      {note !== null && (
        <div className="dp-note" role={note.tone === "danger" ? "alert" : "status"} data-tone={note.tone}>
          {note.text}
        </div>
      )}
      {deck ? (
        <SlidesView
          readOnly
          session={doc.session}
          path={path}
          text={doc.text}
          externalRef={externalRef}
          {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
        />
      ) : (
        <DocView
          session={doc.session}
          path={path}
          initialText={doc.initial.text}
          handleRef={docHandle}
          externalRef={externalRef}
          {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
        />
      )}
    </div>
  );
}

function paperName(paper: DocPaper, t: ReturnType<typeof useT>): string {
  return paper === "quiet" ? t.doc.paperQuiet : paper === "print" ? t.doc.paperPrint : t.doc.paperFocus;
}
