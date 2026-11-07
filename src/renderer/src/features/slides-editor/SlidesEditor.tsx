import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextQuote } from "@shared/quote";
import { DOC_GONE } from "@shared/doc";
import type { SlidesExportFormat } from "@shared/slides-export";
import { richTextToPlain, CANVAS_SIZE, newId, type Aspect, type Deck, type SlideElement } from "../../../../shared/slides.ts";
import { addSlide, appendElements, applyEdit, duplicateSlide, insertImage, newTableElement, newTextBoxFromPlain, removeElements, slideTitle, updateElements, type DrawTool } from "../../../../shared/slides-ops.ts";
import { SLIDE_BACKGROUNDS, SLIDE_DEFAULT_TEXT, SLIDE_PAGE_WHITE } from "../../../../shared/slides-palette.ts";
import { SLIDE_CSS, type RenderContext } from "../../../../shared/slides-render.ts";
import { api } from "../../api";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { Menu } from "../../shell/Menu";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { SelectButton } from "../settings/SettingControls";
import { useT } from "../../locale.ts";
import { useOpenDoc } from "../doc-panel/useOpenDoc.ts";
import type { ExternalChange } from "../doc-panel/doc-session.ts";
import { setOpenDocument } from "../doc-panel/open-document.ts";
import { useAssetUrls } from "./asset-urls.ts";
import { Filmstrip } from "./Filmstrip";
import { ColorButton, FormatBar } from "./FormatBar";
import { fitScale } from "./geometry.ts";
import { PlayMode } from "./PlayMode";
import { SlideStage } from "./SlideStage";
import { copyElements, hasCopiedElements, pasteElements } from "./slide-clipboard.ts";
import { quoteOfDeckPage } from "./slides-quote.ts";
import { deckMerge, useDeckEditor } from "./use-deck-editor.ts";
import "./slides-editor.css";

const ZOOMS = [50, 75, 100, 150, 200] as const;
const FLASH_MS = 3200;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

/**
 * 演示文稿 v2 的编辑面板：打开 `.slides.json`、画布 + 工具条 + 缩略条 + 备注 + 播放 + 导出。
 * 读盘 / 自动保存 / 监听 agent 的改动并结构级合并走 `useOpenDoc` + `DocSession`（文档编辑器同一套，
 * 只把合并函数换成 deckMerge）；agent 与用户的操作调同一批纯函数（shared/slides-ops.ts）。
 */
export function SlidesEditorPane(props: {
  sessionId: string | null;
  workspaceId: string | null;
  path: string;
  onQuote?: (quote: TextQuote) => void;
  onClose?: () => void;
}) {
  const t = useT();
  const { sessionId, workspaceId, path } = props;
  const externalRef = useRef<(change: ExternalChange) => void>(() => undefined);
  const doc = useOpenDoc({ sessionId, workspaceId, path }, (change) => externalRef.current(change), false, deckMerge);

  if (doc.phase === "loading") {
    return (
      <div className="dp se" data-kind="slides">
        <PanelEmpty busy>{t.common.loading}</PanelEmpty>
      </div>
    );
  }
  if (doc.phase === "error" || doc.session === null || doc.initial === null) {
    const gone = doc.loadError?.startsWith(DOC_GONE) === true;
    return (
      <div className="dp se" data-kind="slides">
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
  return (
    <DeckWorkspace
      key={path}
      session={doc.session}
      initialText={doc.initial.text}
      externalRef={externalRef}
      sessionId={sessionId}
      workspaceId={workspaceId}
      path={path}
      status={status}
      syncState={doc.state}
      syncError={doc.syncError}
      {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
    />
  );
}

function DeckWorkspace(props: {
  session: NonNullable<ReturnType<typeof useOpenDoc>["session"]>;
  initialText: string;
  externalRef: { current: (change: ExternalChange) => void };
  sessionId: string | null;
  workspaceId: string | null;
  path: string;
  status: string;
  syncState: string;
  syncError: string | null;
  onQuote?: (quote: TextQuote) => void;
}) {
  const t = useT();
  const { session, sessionId, workspaceId, path } = props;
  const editor = useDeckEditor(session, props.initialText, props.externalRef);
  const { deck } = editor;
  const assets = useAssetUrls({ sessionId, workspaceId, path });
  const ctx: RenderContext = useMemo(
    () => ({ deck: { aspect: deck.aspect, theme: deck.theme, title: deck.title }, imageUrl: assets.imageUrl, editing: true }),
    // version：图取到了要让所有元素重画一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deck.aspect, deck.theme, deck.title, assets.imageUrl, assets.version],
  );
  const playCtx: RenderContext = useMemo(() => ({ ...ctx, editing: false }), [ctx]);

  // ── 当前页 / 选择 / 工具 / 缩放 ──
  const [currentId, setCurrentId] = useState<string | null>(deck.slides[0]?.id ?? null);
  const lastIndex = useRef(0);
  const foundIndex = deck.slides.findIndex((slide) => slide.id === currentId);
  const index = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(lastIndex.current, deck.slides.length - 1));
  lastIndex.current = index;
  const slide = deck.slides[index];
  // 当前页被删 / 文稿从空到有：回写 id，保持「按 id 记当前页」
  useEffect(() => {
    if (slide !== undefined && slide.id !== currentId) setCurrentId(slide.id);
  }, [slide, currentId]);

  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [notesOpen, setNotesOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  // 选择里已不存在的元素（被 agent 删了 / 撤销了）剔掉
  useEffect(() => {
    if (slide === undefined) return;
    const alive = new Set(slide.elements.map((element) => element.id));
    setSelection((current) => {
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
    setEditingId((current) => (current !== null && !alive.has(current) ? null : current));
  }, [slide]);
  // 换页清选择
  useEffect(() => {
    setSelection(new Set());
    setEditingId(null);
  }, [currentId]);

  // 页被外部（agent）改动：缩略图标绿边一会儿。比较引用：没被改的页引用不变
  const previousSlides = useRef(deck.slides);
  const fromSelf = useRef(false);
  useEffect(() => {
    const before = new Map(previousSlides.current.map((s) => [s.id, s]));
    previousSlides.current = deck.slides;
    if (fromSelf.current) {
      fromSelf.current = false;
      return;
    }
    const touched = deck.slides.filter((s) => before.get(s.id) !== undefined && before.get(s.id) !== s).map((s) => s.id);
    const added = deck.slides.filter((s) => !before.has(s.id)).map((s) => s.id);
    const ids = [...touched, ...added];
    if (ids.length === 0) return;
    setFlashIds(new Set(ids));
    const timer = window.setTimeout(() => setFlashIds(new Set()), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [deck.slides]);

  const commit = useCallback(
    (next: Deck, key?: string): void => {
      fromSelf.current = true;
      editor.commit(next, key);
    },
    [editor],
  );
  // 撤销 / 重做是用户自己的动作，缩略图不该当成 agent 改动标绿
  const undo = useCallback((): void => {
    fromSelf.current = true;
    editor.undo();
  }, [editor]);
  const redo = useCallback((): void => {
    fromSelf.current = true;
    editor.redo();
  }, [editor]);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const deckRef = useRef(deck);
  deckRef.current = deck;

  // 登记「此刻开着哪份文件」：发送消息时让模型知道（引用走 slides-quote，不靠文本定位）
  useEffect(() => {
    setOpenDocument({ path, kind: "slides" }, { text: () => session.text, trackedRange: () => null });
    return () => setOpenDocument(null);
  }, [path, session]);

  // ── 画布尺寸与缩放 ──
  // 回调 ref：画布区在「没有页」与「有页」之间会卸载 / 重挂（agent 刚建的文稿一开始是 0 页），
  // 用 useEffect([]) 只在首次挂载时量一次的话，后来挂上的那个元素永远没人量——缩放比就是默认值（实测 44%、画布被裁）
  const [hostSize, setHostSize] = useState({ w: 640, h: 360 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const stageHostRef = useCallback((host: HTMLDivElement | null): void => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (host === null) return;
    const measure = (): void => setHostSize({ w: host.clientWidth, h: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observerRef.current = observer;
  }, []);
  const canvas = CANVAS_SIZE[deck.aspect];
  const scale = zoom === "fit" ? fitScale(hostSize, canvas, 20) : zoom / 100;
  const scaleLabel = `${Math.round(scale * 100)}%`;

  // ── 页操作（同一批纯函数） ──
  const selectIndex = (i: number): void => {
    const target = deck.slides[i];
    if (target !== undefined) setCurrentId(target.id);
  };
  const addPage = (after: number | null): void => {
    const next = addSlide(deck, after);
    commit(next.deck);
    setCurrentId(next.deck.slides[next.index]?.id ?? null);
  };
  const movePage = (from: number, to: number): void => {
    commit(applyEdit(deck, [{ op: "move_slide", slide: from + 1, to: to + 1 }]).deck);
  };
  const duplicatePage = (i: number): void => {
    const next = duplicateSlide(deck, i);
    commit(next.deck);
    setCurrentId(next.deck.slides[next.index]?.id ?? null);
  };
  const deletePage = (i: number): void => {
    if (deck.slides.length <= 1) return;
    const next = applyEdit(deck, [{ op: "delete_slide", slide: i + 1 }]).deck;
    commit(next);
    setCurrentId(next.slides[Math.min(i, next.slides.length - 1)]?.id ?? null);
  };

  // ── 元素操作 ──
  const selectedElements = (): SlideElement[] => (slide === undefined ? [] : slide.elements.filter((element) => selection.has(element.id)));
  const deleteSelection = (): void => {
    if (slide === undefined || selection.size === 0) return;
    commit(removeElements(deck, slide.id, selection));
    setSelection(new Set());
  };
  const duplicateSelection = (): void => {
    if (slide === undefined) return;
    const picked = selectedElements();
    if (picked.length === 0) return;
    const copies = picked.map((element) => ({ ...structuredClone(element), id: newId(), x: element.x + 20, y: element.y + 20 }));
    commit(appendElements(deck, slide.id, copies));
    setSelection(new Set(copies.map((c) => c.id)));
  };
  const nudge = (dx: number, dy: number): void => {
    if (slide === undefined || selection.size === 0) return;
    commit(updateElements(deck, slide.id, (element) => ({ ...element, x: element.x + dx, y: element.y + dy }), selection), "nudge");
  };

  const insertSimple = (element: SlideElement): void => {
    if (slide === undefined) return;
    commit(appendElements(deck, slide.id, [element]));
    setSelection(new Set([element.id]));
  };
  const insertTable = (): void => {
    const table = newTableElement(deck);
    insertSimple(table);
    setEditingId(table.id);
  };

  // ── 图片：选文件 / 拖入 / 粘贴 三条路进同一个函数 ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertImageFiles = useCallback(
    async (files: readonly File[], at?: { x: number; y: number }): Promise<void> => {
      const target = deckRef.current.slides[lastIndex.current];
      if (target === undefined) return;
      let working = deckRef.current;
      let lastId: string | null = null;
      try {
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const added = await api.docs.addSlideAsset({ sessionId, workspaceId, path, name: file.name === "" ? "image" : file.name, bytes });
          assets.prime(added.src, bytes, file.type === "" ? "image/png" : file.type);
          const placement =
            at === undefined
              ? {}
              : (() => {
                  const ratio = added.width > 0 && added.height > 0 ? added.width / added.height : 4 / 3;
                  const canvasSize = CANVAS_SIZE[working.aspect];
                  const w = Math.min(canvasSize.w * 0.5, canvasSize.h * 0.6 * ratio);
                  const h = w / ratio;
                  // 以落点为中心，但整张图要落在画布里（落在边上不该有一半伸出去）
                  return { x: Math.max(0, Math.min(at.x - w / 2, canvasSize.w - w)), y: Math.max(0, Math.min(at.y - h / 2, canvasSize.h - h)) };
                })();
          const placed = insertImage(working, lastIndex.current + 1, added.src, { w: added.width, h: added.height }, placement);
          working = placed.deck;
          lastId = placed.element.id;
        }
        commitRef.current(working);
        if (lastId !== null) setSelection(new Set([lastId]));
      } catch (cause) {
        setNote({ text: t.slides.imageFailed(ipcErrorText(cause)), tone: "danger" });
      }
    },
    [sessionId, workspaceId, path, assets, t],
  );

  // ── 剪贴板：复制 / 剪切 / 粘贴（图片优先，其次本画布复制的元素，最后纯文字成文字框） ──
  const lastCopiedText = useRef<string | null>(null);
  const onCopyOrCut = (event: React.ClipboardEvent, cut: boolean): void => {
    if (isTypingTarget(event.target) || slide === undefined) return;
    const picked = selectedElements();
    if (picked.length === 0) return;
    event.preventDefault();
    copyElements(picked);
    const plain = picked.map((element) => (element.kind === "text" ? richTextToPlain(element.html) : "")).filter((s) => s !== "").join("\n");
    lastCopiedText.current = plain === "" ? "orbita-slide-elements" : plain;
    event.clipboardData.setData("text/plain", lastCopiedText.current);
    if (cut) deleteSelection();
  };
  const onPaste = (event: React.ClipboardEvent): void => {
    if (isTypingTarget(event.target) || slide === undefined || editingId !== null) return;
    const data = event.clipboardData;
    const images = [...data.files].filter((file) => file.type.startsWith("image/"));
    const text = data.getData("text/plain");
    if (images.length > 0) {
      event.preventDefault();
      void insertImageFiles(images);
      return;
    }
    if (hasCopiedElements() && (text === "" || text === lastCopiedText.current)) {
      event.preventDefault();
      const pasted = pasteElements();
      commit(appendElements(deck, slide.id, pasted));
      setSelection(new Set(pasted.map((p) => p.id)));
      return;
    }
    if (text.trim() !== "") {
      event.preventDefault();
      insertSimple(newTextBoxFromPlain(text, deck.theme?.color ?? SLIDE_DEFAULT_TEXT));
    }
  };

  // ── 键盘 ──
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (playing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (isTypingTarget(event.target)) return;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (mod && event.key.toLowerCase() === "a" && slide !== undefined) {
      event.preventDefault();
      setSelection(new Set(slide.elements.map((element) => element.id)));
      return;
    }
    if (mod) return;
    const step = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case "Delete":
      case "Backspace":
        if (selection.size > 0) {
          event.preventDefault();
          deleteSelection();
        }
        break;
      case "ArrowLeft":
        if (selection.size > 0) {
          event.preventDefault();
          nudge(-step, 0);
        }
        break;
      case "ArrowRight":
        if (selection.size > 0) {
          event.preventDefault();
          nudge(step, 0);
        }
        break;
      case "ArrowUp":
        if (selection.size > 0) {
          event.preventDefault();
          nudge(0, -step);
        }
        break;
      case "ArrowDown":
        if (selection.size > 0) {
          event.preventDefault();
          nudge(0, step);
        }
        break;
      case "Enter":
        if (selection.size === 1) {
          const only = selectedElements()[0];
          if (only !== undefined && (only.kind === "text" || only.kind === "shape" || only.kind === "table")) {
            event.preventDefault();
            setEditingId(only.id);
          }
        }
        break;
      case "Escape":
        // 有东西可退（画图工具 / 选中）就只退这一层，别冒到 App 把右栏整个关掉；都没有才放行
        if (tool !== null) {
          setTool(null);
          event.stopPropagation();
        } else if (selection.size > 0) {
          setSelection(new Set());
          event.stopPropagation();
        }
        break;
      case "PageDown":
        event.preventDefault();
        selectIndex(Math.min(deck.slides.length - 1, index + 1));
        break;
      case "PageUp":
        event.preventDefault();
        selectIndex(Math.max(0, index - 1));
        break;
    }
  };

  // ── 导出 / 引用 / 比例 ──
  const exportAs = async (format: SlidesExportFormat): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setNote(null);
    try {
      await session.flush();
      const result = await api.docs.exportSlides({ sessionId, workspaceId, path, format, ...(format === "png" ? { page: index + 1 } : {}) });
      if (result.saved !== null) setNote({ text: t.doc.exported(result.saved), tone: "ok" });
    } catch (cause) {
      setNote({ text: t.doc.exportFailed(ipcErrorText(cause)), tone: "danger" });
    } finally {
      setExporting(false);
    }
  };
  useEffect(() => {
    if (note === null) return undefined;
    const timer = window.setTimeout(() => setNote(null), note.tone === "danger" ? 10000 : 4000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const quote = (): void => {
    if (slide === undefined) return;
    const picked = selectedElements();
    const result = quoteOfDeckPage({ path, deck, page: index + 1, ...(picked.length === 1 ? { elementId: (picked[0] as SlideElement).id } : {}) });
    if (result !== null) props.onQuote?.(result);
    document.querySelector<HTMLTextAreaElement>(".pane-main textarea.composer-input")?.focus();
  };

  const setAspect = (aspect: Aspect): void => {
    if (aspect !== deck.aspect) commit(applyEdit(deck, [{ op: "set_deck", aspect }]).deck);
  };

  const exportItems = [
    { id: "pdf", format: "pdf", label: t.slides.exportPdf, hint: ".pdf" },
    { id: "html", format: "html", label: t.slides.exportHtml, hint: ".html" },
    { id: "png", format: "png", label: t.slides.exportPng, hint: ".png" },
    { id: "rule", rule: true },
    { id: "pptx", format: "pptx", label: t.slides.exportPptx, hint: ".pptx" },
    { id: "pptx-basic", format: "pptx-basic", label: t.slides.exportPptxBasic, hint: ".pptx" },
    { id: "note", fact: true, label: t.slides.exportFontNote },
  ] as const;

  const toolButton = (label: string, icon: Parameters<typeof Icon>[0]["name"], onClick: () => void, active = false) => (
    <button type="button" className="se-tool" aria-pressed={active} title={label} onClick={onClick}>
      <Icon name={icon} size={16} strokeWidth={1.8} />
      <span className="se-tool-label">{label}</span>
    </button>
  );

  const shapeItems: { id: DrawTool; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
    { id: "rect", label: t.slides.shapeRect, icon: "square" },
    { id: "roundRect", label: t.slides.shapeRoundRect, icon: "square-round-corner" },
    { id: "ellipse", label: t.slides.shapeEllipse, icon: "circle" },
    { id: "triangle", label: t.slides.shapeTriangle, icon: "triangle" },
    { id: "line", label: t.slides.shapeLine, icon: "minus" },
    { id: "arrow", label: t.slides.shapeArrow, icon: "arrow-right" },
  ];

  const banner =
    props.syncState === "readonly"
      ? t.doc.readonlyNotice
      : props.syncState === "gone"
        ? t.doc.goneNotice
        : props.syncState === "error"
          ? t.doc.saveFailed(props.syncError ?? "")
          : null;

  if (deck.slides.length === 0 || slide === undefined) {
    return (
      <div className="dp se" data-kind="slides">
        <PanelEmpty icon={FEATURE_ICON.slides} exit={{ label: t.slides.addPage, onClick: () => addPage(null) }}>
          {t.slides.emptyDeck}
        </PanelEmpty>
      </div>
    );
  }

  return (
    <div className="dp se" data-kind="slides" onKeyDown={onKeyDown} onCopy={(e) => onCopyOrCut(e, false)} onCut={(e) => onCopyOrCut(e, true)} onPaste={onPaste}>
      {/* 页面本身的样式（位置 / 文字 / 表格 / 形状），与导出共用同一份字符串 */}
      <style>{SLIDE_CSS}</style>
      <div className="se-bar" role="toolbar" aria-label={t.slides.toolbar}>
        {toolButton(t.slides.text, "type", () => setTool((v) => (v === "text" ? null : "text")), tool === "text")}
        {toolButton(t.slides.image, "image", () => fileInputRef.current?.click())}
        {toolButton(t.slides.table, "table", insertTable)}
        <Menu
          items={shapeItems.map((item) => ({ id: item.id, label: item.label, icon: item.icon, checked: tool === item.id, onSelect: () => setTool(item.id) }))}
          trigger={({ open, toggle }) => (
            <button type="button" className="se-tool" aria-expanded={open} aria-pressed={tool !== null && tool !== "text"} title={t.slides.shapes} onClick={toggle}>
              <Icon name="shapes" size={16} strokeWidth={1.8} />
              <span className="se-tool-label">{t.slides.shapes}</span>
              <Icon name="chevron-down" size={12} strokeWidth={2} />
            </button>
          )}
        />
        <span className="dp-bar-grow" />
        <IconButton label={t.doc.undo} size={28} disabled={!editor.canUndo} onClick={undo}>
          <Icon name="undo-2" size={16} strokeWidth={1.8} />
        </IconButton>
        <IconButton label={t.slides.redo} size={28} disabled={!editor.canRedo} onClick={redo}>
          <Icon name="redo-2" size={16} strokeWidth={1.8} />
        </IconButton>
        {/* 已保存是常态，不占位；只有保存中 / 没存 / 失败才出字 */}
        <span className="dp-status" data-state={props.syncState} role="status" title={props.syncError ?? props.status}>
          {props.syncState === "saved" ? <Icon name="check" size={14} strokeWidth={2} /> : props.status}
        </span>
        <Menu
          align="end"
          items={exportItems.map((item) =>
            "rule" in item
              ? { id: item.id, label: "", rule: true }
              : "fact" in item
                ? { id: item.id, label: item.label, fact: true }
                : { id: item.id, label: item.label, hint: item.hint, disabled: exporting, onSelect: () => void exportAs(item.format as SlidesExportFormat) },
          )}
          trigger={({ open, toggle }) => (
            <button type="button" className="se-tool se-tool-menu" aria-expanded={open} disabled={exporting} onClick={toggle}>
              <Icon name={exporting ? "loader-circle" : "download"} size={16} strokeWidth={1.8} spin={exporting} />
              <span className="se-tool-label">{t.slides.export}</span>
              <Icon name="chevron-down" size={12} strokeWidth={2} />
            </button>
          )}
        />
        <button type="button" className="se-tool se-tool-primary" onClick={() => setPlaying(true)}>
          <Icon name="play" size={16} strokeWidth={1.8} />
          <span className="se-tool-label">{t.slides.play}</span>
        </button>
        <Menu
          align="end"
          items={(["16:9", "4:3"] as const).map((aspect) => ({ id: aspect, label: aspect, checked: deck.aspect === aspect, onSelect: () => setAspect(aspect) }))}
          trigger={({ open, toggle }) => (
            <SelectButton open={open} onClick={toggle} title={t.slides.aspect}>
              {deck.aspect}
            </SelectButton>
          )}
        />
        <Menu
          align="end"
          items={[
            { id: "fit", label: t.slides.zoomFit, checked: zoom === "fit", onSelect: () => setZoom("fit") },
            ...ZOOMS.map((z) => ({ id: String(z), label: `${z}%`, checked: zoom === z, onSelect: () => setZoom(z) })),
          ]}
          trigger={({ open, toggle }) => (
            <SelectButton open={open} onClick={toggle} title={t.slides.zoom}>
              {scaleLabel}
            </SelectButton>
          )}
        />
      </div>
      <FormatBar
        deck={deck}
        slide={slide}
        selection={selection}
        editing={editingId !== null}
        commit={commit}
        onDelete={deleteSelection}
        onDuplicate={duplicateSelection}
        onQuote={quote}
      />
      {banner !== null && (
        <div className="dp-banner" role="alert">
          <span className="dp-banner-text" title={banner}>
            {banner}
          </span>
        </div>
      )}
      {note !== null && (
        <div className="dp-note" role={note.tone === "danger" ? "alert" : "status"} data-tone={note.tone}>
          {note.text}
        </div>
      )}
      <div className="se-stage-host" ref={stageHostRef} data-zoom={zoom === "fit" ? "fit" : "fixed"}>
        <div className="se-stage-scroll">
          <SlideStage
            key={slide.id}
            deck={deck}
            slide={slide}
            ctx={ctx}
            scale={scale}
            selection={selection}
            onSelect={setSelection}
            commit={commit}
            tool={tool}
            onToolDone={() => setTool(null)}
            editingId={editingId}
            onEditing={setEditingId}
            onDropImages={(files, at) => void insertImageFiles(files, at)}
          />
        </div>
      </div>
      <Filmstrip
        deck={deck}
        ctx={ctx}
        currentId={slide.id}
        flashIds={flashIds}
        onSelect={selectIndex}
        onAdd={addPage}
        onMove={movePage}
        onDuplicate={duplicatePage}
        onDelete={deletePage}
        notesOpen={notesOpen}
        onToggleNotes={() => setNotesOpen((v) => !v)}
        extra={
          <>
            <ColorButton
              label={t.slides.background}
              value={slide.background ?? deck.theme?.background ?? SLIDE_PAGE_WHITE}
              palette={SLIDE_BACKGROUNDS}
              up
              onPick={(color) => commit(applyEdit(deck, [{ op: "set_slide", slide: index + 1, background: color }]).deck)}
            />
            <button type="button" className="se-notes-toggle" onClick={quote} title={t.slides.quotePage}>
              <Icon name="quote" size={14} strokeWidth={1.8} />
              {t.slides.quotePage}
            </button>
          </>
        }
      />
      {notesOpen && (
        <div className="se-notes">
          <label className="se-notes-label" htmlFor="se-notes-input">
            {t.slides.notesFor(index + 1, slideTitle(slide))}
          </label>
          <textarea
            id="se-notes-input"
            className="se-notes-input"
            value={slide.notes ?? ""}
            placeholder={t.slides.notesPlaceholder}
            onChange={(event) => commit(applyEdit(deck, [{ op: "set_slide", slide: index + 1, notes: event.target.value }]).deck, `notes:${slide.id}`)}
          />
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) void insertImageFiles(files);
        }}
      />
      {playing && <PlayMode deck={deck} ctx={playCtx} startIndex={index} onExit={() => setPlaying(false)} />}
    </div>
  );
}

