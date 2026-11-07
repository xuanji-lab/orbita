import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextQuote } from "@shared/quote";
import { docTitle } from "@shared/doc";
import { insertPageAfter, parseDeck, removePage } from "@shared/doc-slides";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { IconButton } from "../../shell/IconButton";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { useT } from "../../locale.ts";
import { DocEditor, type DocEditorHandle, type EditorSelectionInfo } from "./DocEditor";
import type { DocSession, ExternalChange } from "./doc-session.ts";
import { quoteOfPageSelection, quoteOfSlide } from "./doc-quote.ts";
import { SlideCanvas } from "./slide-render";
import { pageCaption } from "./slide-columns.ts";
import { useQuoteCandidate } from "./useQuoteCandidate";
import { getView, setView } from "./view-memory.ts";

/** 新增 / 改动的页缩略图标绿边多久 */
const FLASH_MS = 3200;

/**
 * 演示文稿视图：左侧缩略条、右侧当前页（16:9）与这一页的源码编辑器。
 * 整份文件是一个 `.md`，`---` 分页；这里没有第二份「页模型」——页是从全文现算的（`parseDeck`），
 * 用户改一页就是把那一页的区间换成新文字再拼回全文，其余页逐字不动。
 */
export function SlidesView(props: {
  session: DocSession;
  path: string;
  /** 全文的实时副本（每次编辑 / 外部合并都更新，缩略条靠它重画） */
  text: string;
  externalRef: { current: (change: ExternalChange) => void };
  onQuote?: (quote: TextQuote) => void;
}) {
  const t = useT();
  const { session, path, text, externalRef } = props;
  const deck = useMemo(() => parseDeck(text), [text]);
  const title = docTitle(path);
  const total = deck.pages.length;
  // 上次停在哪页（关面板再开 / 重启后回到原处；页数变少时下面 index 会夹回去）
  const [current, setCurrent] = useState(() => getView(path).page ?? 0);
  const index = Math.min(current, Math.max(total - 1, 0));
  const page = deck.pages[index];
  const pageHandle = useRef<DocEditorHandle | null>(null);
  /** 页内源码编辑器默认收起（预览为主）：点「编辑这一页」或双击预览展开，展开时预览缩小在上 */
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editing) pageHandle.current?.focus();
  }, [editing, current]);
  const [flashPages, setFlashPages] = useState<ReadonlySet<number>>(new Set());
  const flashTimer = useRef<number | undefined>(undefined);
  /** 页内编辑器管的那一段文字在全文里的区间：换页 / 外部合并时按当前页重新锚定；之后每次编辑跟着长短走 */
  const region = useRef<{ index: number; from: number; to: number } | null>(null);
  useEffect(() => {
    if (total > 0) setView(path, { page: index });
  }, [path, index, total]);
  const indexRef = useRef(index);
  indexRef.current = index;
  if (page !== undefined && region.current?.index !== index) {
    region.current = { index, from: page.from, to: page.to };
  }

  // agent 的改动并进来：新增 / 改动所在的页标绿；当前页的源码编辑器按最小差异对齐
  useEffect(() => {
    externalRef.current = (change) => {
      const next = parseDeck(change.text);
      const touched = new Set<number>();
      for (const range of change.inserted) {
        next.pages.forEach((candidate, i) => {
          if (range.from <= candidate.to && range.to >= candidate.from) touched.add(i);
        });
      }
      if (touched.size > 0) {
        setFlashPages(touched);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashPages(new Set()), FLASH_MS);
      }
      const here = next.pages[indexRef.current];
      if (here === undefined) return;
      region.current = { index: indexRef.current, from: here.from, to: here.to };
      const shifted = change.inserted
        .filter((range) => range.to > here.from && range.from < here.to)
        .map((range) => ({ from: Math.max(range.from, here.from) - here.from, to: Math.min(range.to, here.to) - here.from }));
      pageHandle.current?.setText(here.text, shifted);
    };
    return () => {
      externalRef.current = () => undefined;
      window.clearTimeout(flashTimer.current);
    };
  }, [externalRef]);

  const addPage = useCallback((): void => {
    const next = insertPageAfter(session.text, total === 0 ? null : index);
    session.edit(next.text);
    setCurrent(next.index);
  }, [session, total, index]);

  const deletePage = useCallback((): void => {
    if (page === undefined) return;
    session.edit(removePage(session.text, index));
    setCurrent(Math.max(0, Math.min(index, total - 2)));
  }, [session, page, index, total]);

  const quotePage = useCallback((): void => {
    const quote = quoteOfSlide({ path, text: session.text, page: index });
    if (quote !== null) props.onQuote?.(quote);
    document.querySelector<HTMLTextAreaElement>(".pane-main textarea.composer-input")?.focus();
  }, [path, session, index, props]);

  const buildQuote = useCallback(
    (selection: EditorSelectionInfo) => {
      const at = region.current;
      if (at === null) return null;
      const quote = quoteOfPageSelection({
        path,
        fullText: session.text,
        regionFrom: at.from,
        from: selection.from,
        to: selection.to,
        page: at.index,
      });
      const raw = session.text.slice(at.from + selection.from, at.from + selection.to);
      return quote === null ? null : { quote, raw };
    },
    [path, session],
  );
  const { onSelection, toolbar } = useQuoteCandidate({
    buildQuote,
    clearSelection: () => pageHandle.current?.clearSelection(),
    ...(props.onQuote === undefined ? {} : { onQuote: props.onQuote }),
  });

  const onPageEdit = useCallback(
    (pageText: string): void => {
      const at = region.current;
      if (at === null) return;
      const full = session.text;
      session.edit(`${full.slice(0, at.from)}${pageText}${full.slice(at.to)}`);
      at.to = at.from + pageText.length;
    },
    [session],
  );

  const onStripKey = (event: React.KeyboardEvent): void => {
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    setCurrent(Math.max(0, Math.min(total - 1, index + delta)));
  };

  if (total === 0 || page === undefined) {
    return (
      <div className="dp-slides-empty">
        <PanelEmpty icon={FEATURE_ICON.slides} exit={{ label: t.doc.addPage, onClick: addPage }}>
          {t.doc.slidesEmpty}
        </PanelEmpty>
      </div>
    );
  }

  return (
    <div className="dp-slides">
      <div className="dp-thumbs" role="listbox" aria-label={t.doc.pagesAria} onKeyDown={onStripKey}>
        {deck.pages.map((each, i) => (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={i === index}
            aria-label={t.doc.pageLabel(i + 1)}
            className="dp-thumb"
            data-new={flashPages.has(i) ? "true" : undefined}
            onClick={() => setCurrent(i)}
          >
            <SlideCanvas text={each.text} number={i + 1} total={total} title={title} />
            <span className="dp-thumb-cap">
              <span className="dp-thumb-n">{i + 1}</span>
              <span className="dp-thumb-title">{pageCaption(each.text) || t.doc.blankPage}</span>
            </span>
          </button>
        ))}
        <button type="button" className="dp-thumb-add" onClick={addPage}>
          <Icon name="plus" size={14} strokeWidth={2} />
          <span>{t.doc.addPage}</span>
        </button>
      </div>
      <div className="dp-slide-main" data-editing={editing ? "true" : undefined}>
        <div
          className="dp-slide-stage"
          data-new={flashPages.has(index) ? "true" : undefined}
          onDoubleClick={() => setEditing((value) => !value)}
        >
          <SlideCanvas text={page.text} number={index + 1} total={total} title={title} overflowLabel={t.doc.slideOverflow} />
        </div>
        <div className="dp-slide-actions">
          <span className="dp-slide-count">
            {t.doc.pageLabel(index + 1)} · {t.doc.pageCount(total)}
          </span>
          <span className="dp-bar-grow" />
          <button type="button" className="dp-text-action" onClick={() => setEditing((value) => !value)}>
            <Icon name="pencil-line" size={14} strokeWidth={1.8} />
            {editing ? t.doc.doneEdit : t.doc.editPage}
          </button>
          <button type="button" className="dp-text-action" onClick={quotePage}>
            <Icon name="quote" size={14} strokeWidth={1.8} />
            {t.doc.quotePage}
          </button>
          <IconButton label={t.doc.deletePage} size={28} onClick={deletePage}>
            <Icon name="trash-2" size={16} strokeWidth={1.8} />
          </IconButton>
        </div>
        {editing && (
          <div className="dp-slide-source" aria-label={t.doc.pageSource}>
            <DocEditor
              key={index}
              initialText={page.text}
              onChange={onPageEdit}
              onSelection={onSelection}
              handleRef={pageHandle}
              ariaLabel={t.doc.pageSource}
            />
          </div>
        )}
      </div>
      {toolbar}
    </div>
  );
}
