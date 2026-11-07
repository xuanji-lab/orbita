import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextQuote } from "@shared/quote";
import { DOC_GONE, docTitle, type DocExportDocFormat, type OfmResolved } from "@shared/doc";
import { isDeckText } from "@shared/doc-slides";
import { DOC_PAPERS, type DocPaper } from "@shared/settings";
import { api } from "../../api";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { Chip } from "../../shell/Chip";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { Menu } from "../../shell/Menu";
import { SelectButton } from "../settings/SettingControls";
import { useT } from "../../locale.ts";
import type { ExternalChange } from "./doc-session.ts";
import { useOpenDoc } from "./useOpenDoc.ts";
import { useDocPaper } from "./doc-paper.ts";
import { setOpenDocument } from "./open-document.ts";
import { DocView } from "./DocView";
import { OfmReader, PlainTextReader } from "./OfmReader";
import { createTargetResolver } from "./ofm-targets.ts";
import type { OfmEnv } from "./ofm-env.ts";
import { docScope, getView, setLast, setView } from "./view-memory.ts";
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
export function DocEditPane(props: {
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
  /** 点文档里的双链 / 嵌入：在文件面板里打开解析到的文件；缺席 = 双链只读不跳 */
  onOpenFile?: (target: NonNullable<OfmResolved>) => void;
  /** 刚新建的文档：进编辑视图（其余默认阅读，或上次停的视图） */
  startInEdit?: boolean;
}) {
  const t = useT();
  const { sessionId, workspaceId, path } = props;
  const { paper, locked, setPaper } = useDocPaper();
  // 外部合并结果怎么落进屏幕由具体视图（文档 / 演示文稿）决定，它们把处理函数挂在这里
  const externalRef = useRef<(change: ExternalChange) => void>(() => undefined);
  const docHandle = useRef<DocEditorHandle | null>(null);
  // 文档还是演示文稿：打开时读到的文件头定，编辑期间不变（agent 整份重写丢了 front matter 也不会把视图换掉）
  const [deck, setDeck] = useState(false);
  // ---- 文档的三个视图：阅读（remark 渲染）/ 编辑（实时预览）/ 源码；.txt 没有源码（它本来就是纯文本）----
  const plainText = /\.txt$/i.test(path);
  const [viewMode, setViewMode] = useState<"read" | "edit" | "source">(() => {
    if (props.startInEdit === true) return "edit";
    const saved = getView(path).view;
    return saved === "source" && /\.txt$/i.test(path) ? "edit" : (saved ?? "read");
  });
  const pickView = useCallback(
    (next: "read" | "edit" | "source"): void => {
      setViewMode(next);
      setView(path, { view: next });
    },
    [path],
  );
  // 阅读视图要随 agent 的改动实时更新：只在阅读时让会话回报全文（编辑时每个字都重渲染不值得）
  const reading = !deck && viewMode === "read";
  const doc = useOpenDoc({ sessionId, workspaceId, path }, (change) => externalRef.current(change), deck || reading);
  useEffect(() => {
    if (doc.initial !== null) setDeck(isDeckText(doc.initial.text));
  }, [doc.initial]);

  // 一份空文档（刚新建 / 清空了的）从阅读视图点开是一张白纸：直接进编辑，除非用户以前选过视图
  useEffect(() => {
    if (doc.initial?.text === "" && getView(path).view === undefined) setViewMode("edit");
  }, [doc.initial, path]);

  const ready = doc.phase === "ready" && doc.session !== null && doc.initial !== null;
  // 记下「这个工作区最近开的文档」：右栏「文档」入口据此回到它
  useEffect(() => {
    if (ready && !deck) setLast(docScope(workspaceId, "doc"), path);
  }, [ready, deck, workspaceId, path]);
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

  /** 演示文稿（Marp）导出 PDF：renderer 渲好整份 HTML，主进程打印 */
  const exportNow = useCallback(async (): Promise<void> => {
    const session = doc.session;
    if (session === null || exporting || !deck) return;
    setExporting(true);
    setNote(null);
    try {
      // 先把没写的写掉：PDF 用的是这一刻的全文
      await session.flush();
      const target = { sessionId, workspaceId, path };
      const pages = parseDeck(session.text).pages.map((page) => page.text);
      const result = await api.docs.export({
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
      if (result.saved !== null) {
        // 超出 16:9 的页在 PDF 里是被裁掉的：导出完成提示里把页号列出来
        const cut = overflowPages(pages, paper);
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

  /** 文档导出：Word / PDF / Markdown / 通用 Markdown（主进程弹保存对话框；生成函数与 agent 的 doc_export 共用） */
  const exportDocument = useCallback(
    async (format: DocExportDocFormat): Promise<void> => {
      const session = doc.session;
      if (session === null || exporting) return;
      setExporting(true);
      setNote(null);
      try {
        await session.flush();
        const result = await api.docs.exportDoc({ sessionId, workspaceId, path, format, text: session.text });
        if (result.saved !== null) setNote({ text: t.doc.exported(result.saved), tone: "ok" });
      } catch (cause) {
        setNote({ text: t.doc.exportFailed(ipcErrorText(cause)), tone: "danger" });
      } finally {
        setExporting(false);
      }
    },
    [doc.session, exporting, sessionId, workspaceId, path, t],
  );

  // ---- Obsidian 语法的环境：双链 / 图片怎么找到真文件、点了打开什么 ----
  const [envVersion, setEnvVersion] = useState(0);
  const resolver = useMemo(
    () => createTargetResolver((items) => api.docs.resolveTargets({ sessionId, workspaceId, path, items })),
    [sessionId, workspaceId, path],
  );
  const openFileRef = useRef(props.onOpenFile);
  openFileRef.current = props.onOpenFile;
  const env = useMemo<OfmEnv>(
    () => ({
      resolver,
      scope: { sessionId, workspaceId },
      onOpen: (target) => openFileRef.current?.(target),
      onMissing: (name) => setNote({ text: t.doc.linkMissing(name), tone: "danger" }),
    }),
    // envVersion 变 = 工作区文件可能变了（agent 新建了笔记 / 插了图）：新身份让阅读视图的双链与图片重新解析
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolver, sessionId, workspaceId, t, envVersion],
  );
  const bumpEnv = useCallback((): void => {
    resolver.invalidate();
    setEnvVersion((v) => v + 1);
    docHandle.current?.refreshOfm();
  }, [resolver]);

  // 阅读视图的正文：切进阅读时取会话里最新的全文，之后随会话回报（agent 改动）更新
  const readText = useMemo(
    () => (viewMode === "read" && doc.session !== null ? doc.session.text : ""),
    // doc.text 变 = 会话回报了新全文
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewMode, doc.session, doc.text],
  );
  useEffect(() => {
    if (viewMode === "read" && doc.session !== null) bumpEnv();
    // 文本变了（agent 可能刚建了笔记 / 图）就重新解析
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, doc.text]);

  /** 插图：toolbar 选图 / 拖入 / 粘贴。图复制进附件目录，在光标处（阅读视图里是文末）插入引用 */
  const insertImages = useCallback(
    async (files?: File[]): Promise<void> => {
      const session = doc.session;
      if (session === null) return;
      setNote(null);
      try {
        const inserted: string[] = [];
        if (files === undefined) {
          const one = await api.docs.insertImage({ sessionId, workspaceId, path, source: { kind: "pick" } });
          if (one !== null) inserted.push(one.markdown);
        } else {
          for (const file of files) {
            const base64 = await fileToBase64(file);
            const name = file.name !== "" && file.name !== "image.png" ? file.name : `Pasted image ${timestampName()}.png`;
            const one = await api.docs.insertImage({ sessionId, workspaceId, path, source: { kind: "bytes", name, base64 } });
            if (one !== null) inserted.push(one.markdown);
          }
        }
        if (inserted.length === 0) return;
        const markdown = inserted.join("\n\n");
        if (docHandle.current !== null) docHandle.current.insertText(markdown);
        else session.edit(`${session.text.replace(/\n*$/, "\n\n")}${markdown}\n`);
        bumpEnv();
      } catch (cause) {
        setNote({ text: t.doc.insertImageFailed(ipcErrorText(cause)), tone: "danger" });
      }
    },
    [doc.session, sessionId, workspaceId, path, t, bumpEnv],
  );

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
          <div className="dp-views" role="group" aria-label={t.doc.viewSwitch}>
            <Chip icon="eye" active={viewMode === "read"} onClick={() => pickView("read")}>
              {t.doc.viewRead}
            </Chip>
            <Chip icon="pencil-line" active={viewMode === "edit"} onClick={() => pickView("edit")}>
              {t.doc.edit}
            </Chip>
            {!plainText && (
              <Chip icon="file-code-2" active={viewMode === "source"} onClick={() => pickView("source")}>
                {t.doc.viewSource}
              </Chip>
            )}
          </div>
        )}
        {!deck && viewMode === "edit" && !plainText && (
          <>
            <span className="dp-bar-rule" aria-hidden="true" />
            <IconButton label={t.doc.heading} size={28} onClick={() => docHandle.current?.command("heading")}>
              <Icon name="heading" size={16} strokeWidth={1.8} />
            </IconButton>
            <IconButton label={t.doc.bold} size={28} onClick={() => docHandle.current?.command("bold")}>
              <Icon name="bold" size={16} strokeWidth={1.8} />
            </IconButton>
            <IconButton label={t.doc.list} size={28} onClick={() => docHandle.current?.command("list")}>
              <Icon name="list" size={16} strokeWidth={1.8} />
            </IconButton>
          </>
        )}
        {!deck && viewMode !== "read" && (
          <IconButton label={t.doc.undo} size={28} onClick={() => docHandle.current?.command("undo")}>
            <Icon name="undo-2" size={16} strokeWidth={1.8} />
          </IconButton>
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
            <SelectButton
              open={open}
              onClick={toggle}
              disabled={locked}
              title={`${t.doc.paperLabel}：${paperName(paper, t)}${locked ? `（${t.doc.paperLocked}）` : ""}`}
            >
              {paperName(paper, t)}
            </SelectButton>
          )}
        />
        {deck ? (
          <IconButton label={t.doc.exportPdf} size={28} disabled={exporting} onClick={() => void exportNow()}>
            <Icon name={exporting ? "loader-circle" : "download"} size={16} strokeWidth={1.8} spin={exporting} />
          </IconButton>
        ) : (
          <>
            <button type="button" className="dp-text-action" onClick={() => void insertImages()}>
              <Icon name="image" size={14} strokeWidth={1.8} />
              {t.doc.insertImage}
            </button>
            <Menu
              items={[
                { id: "docx", label: t.doc.exportDocx, hint: ".docx", onSelect: () => void exportDocument("docx") },
                { id: "pdf", label: t.doc.exportPdfMenu, hint: ".pdf", onSelect: () => void exportDocument("pdf") },
                { id: "md", label: t.doc.exportMd, hint: ".md", onSelect: () => void exportDocument("md") },
                { id: "md-plain", label: t.doc.exportMdPlain, hint: ".md", onSelect: () => void exportDocument("md-plain") },
                { id: "rule", label: "", rule: true },
                { id: "hint", label: t.doc.exportOfmHint, fact: true },
              ]}
              align="end"
              trigger={({ open, toggle }) => (
                <button type="button" className="dp-text-action" aria-expanded={open} disabled={exporting} onClick={toggle}>
                  <Icon name={exporting ? "loader-circle" : "download"} size={14} strokeWidth={1.8} spin={exporting} />
                  {t.doc.exportMenu}
                  <Icon name="chevron-down" size={12} strokeWidth={2} />
                </button>
              )}
            />
          </>
        )}
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
      {note !== null && (
        <div className="dp-note" role={note.tone === "danger" ? "alert" : "status"} data-tone={note.tone}>
          {note.text}
        </div>
      )}
      {deck ? (
        <SlidesView
          session={doc.session}
          path={path}
          text={doc.text}
          externalRef={externalRef}
          {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
        />
      ) : (
        viewMode === "read" ? (
          <DocReadBody text={readText} plain={plainText} env={env} />
        ) : (
          <DocView
            session={doc.session}
            path={path}
            initialText={doc.session.text}
            handleRef={docHandle}
            externalRef={externalRef}
            view={viewMode === "source" ? "source" : plainText ? "plain" : "live"}
            {...(plainText ? {} : { ofm: { env, missingText: t.doc.imageMissing } })}
            onImages={(files) => void insertImages(files)}
            {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
          />
        )
      )}
    </div>
  );
}

/** 阅读视图：一页纸（与编辑视图同一个 .dp-page，纸面主题一并生效） */
function DocReadBody(props: { text: string; plain: boolean; env: OfmEnv }) {
  return (
    <div className="dp-scroll">
      <div className="dp-page dp-read">
        {props.plain ? <PlainTextReader text={props.text} /> : <OfmReader text={props.text} env={props.env} />}
      </div>
    </div>
  );
}

function paperName(paper: DocPaper, t: ReturnType<typeof useT>): string {
  return paper === "quiet" ? t.doc.paperQuiet : paper === "print" ? t.doc.paperPrint : t.doc.paperFocus;
}

function timestampName(): string {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** File → 不带 data: 前缀的 base64（拖入 / 粘贴的图过 IPC 用） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读图失败"));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.readAsDataURL(file);
  });
}
