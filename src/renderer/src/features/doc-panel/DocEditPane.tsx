import { useCallback, useEffect, useRef, useState } from "react";
import type { TextQuote } from "@shared/quote";
import { docTitle } from "@shared/doc";
import { isDeckText } from "@shared/doc-slides";
import { DOC_PAPERS, type DocPaper } from "@shared/settings";
import { api } from "../../api";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { useT } from "../../locale.ts";
import type { ExternalChange } from "./doc-session.ts";
import { useOpenDoc } from "./useOpenDoc.ts";
import { useDocPaper } from "./doc-paper.ts";
import { setOpenDocument } from "./open-document.ts";
import { DocView } from "./DocView";
import { SlidesView } from "./SlidesView";
import { deckHtml, resolvedTokenCss } from "./slide-render";
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
}) {
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
    setOpenDocument({ path, kind: deck ? "slides" : "doc" });
    return () => setOpenDocument(null);
  }, [ready, path, deck]);

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
    const timer = window.setTimeout(() => setNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [note]);

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
                theme: document.documentElement.dataset["theme"] ?? "light",
                tokens: resolvedTokenCss(),
              }),
              pages: pages.length,
            });
          })()
        : await api.docs.export({ ...target, format: "docx" });
      if (result.saved !== null) setNote({ text: t.doc.exported(result.saved), tone: "ok" });
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
    return (
      <div className="dp" data-paper={paper}>
        <PanelEmpty tone="danger" hint={doc.loadError ?? undefined}>
          {t.doc.loadFailed}
        </PanelEmpty>
      </div>
    );
  }

  const status =
    doc.state === "error"
      ? t.doc.saveFailed(doc.syncError ?? "")
      : doc.state === "saving"
        ? t.doc.saving
        : doc.state === "dirty"
          ? t.doc.dirty
          : t.doc.saved;

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
        <div className="dp-papers" role="group" aria-label={t.doc.paperLabel} title={locked ? t.doc.paperLocked : undefined}>
          {DOC_PAPERS.map((value) => (
            <PaperSwatch
              key={value}
              paper={value}
              label={paperName(value, t)}
              pressed={paper === value}
              disabled={locked}
              onPick={() => setPaper(value)}
            />
          ))}
        </div>
        <IconButton
          label={deck ? t.doc.exportPdf : t.doc.exportWord}
          size={28}
          disabled={exporting}
          onClick={() => void exportNow()}
        >
          <Icon name={exporting ? "loader-circle" : "download"} size={16} strokeWidth={1.8} spin={exporting} />
        </IconButton>
      </div>
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

/** 纸面切换里的一格：一枚小色块（纸色 + 该纸面的记号色），名字在 tooltip 与读屏里 */
function PaperSwatch(props: { paper: DocPaper; label: string; pressed: boolean; disabled: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      className="dp-paper"
      data-paper-swatch={props.paper}
      aria-pressed={props.pressed}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onPick}
    />
  );
}
