import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { clearFlash, flashRanges, liveMarkdown } from "./cm-live-markdown.ts";
import { diffToChanges, type TextChange } from "./doc-merge.ts";
import { quoteTrackField, quoteTracker, trackRange } from "./quote-track.ts";
import type { TrackedSnapshot } from "./quote-track.ts";
import { cycleHeading, toggleBold, toggleList } from "./doc-commands.ts";
import { documentKeymap, External, titleAfterComposition, titleFirstFilter } from "./doc-extensions.ts";

/** 编辑器里一次选区（偏移按编辑器自己的文本算） */
export interface EditorSelectionInfo {
  from: number;
  to: number;
  /** 报告这次选区时的文档快照（不透明对象）：`trackQuote` 拿它核对「文档自那以后没变过」，防止用过期坐标登记 */
  docVersion: unknown;
  /** 选区在视口里的位置（划选浮条用，同对话里划选的 candidate）：x 取选区水平中点 */
  rect: { x: number; top: number; bottom: number };
}

export type EditorCommand = "heading" | "bold" | "list" | "undo" | "redo";

/** 父组件拿到的把手：把外部合并结果并进来、跑工具栏命令 */
export interface DocEditorHandle {
  /** 直接按合并结果给出的改动改（坐标在当前文本里）；`flash` 是新增区间（坐标在改后的文本里） */
  applyChanges(changes: readonly TextChange[], flash: { from: number; to: number }[]): void;
  /** 把文本整个换成 `text`，只动有差异的地方（页编辑器重新对齐用） */
  setText(text: string, flash?: { from: number; to: number }[]): void;
  getText(): string;
  command(name: EditorCommand): void;
  focus(): void;
  /** 收起选区（引用 / 摘抄做完后） */
  clearSelection(): void;
  /** 登记一段被引用的区间，之后随每次改动映射（quote-track.ts） */
  trackQuote(id: string, from: number, to: number, docVersion: unknown): boolean;
  /** 被引用区间现在在哪；追踪不到 = null */
  trackedRange(id: string): { from: number; to: number } | null;
}

/** 新增段落绿边保持多久（CSS 动画淡出，到点再清装饰） */
const FLASH_MS = 3200;

export function DocEditor(props: {
  initialText: string;
  onChange: (text: string) => void;
  onSelection: (selection: EditorSelectionInfo | null) => void;
  /** 空文档时的占位（两行：标题 / 正文） */
  emptyHint?: { title: string; body: string };
  handleRef: { current: DocEditorHandle | null };
  ariaLabel: string;
  /**
   * 文档模式：回车 = 新段落（写成空行分隔）、Shift+回车 = 段内换行；空文档里打的第一个字自动成为
   * 一级标题（落盘 `# `，占位写的「标题」就是这个意思）。幻灯片页内的源码编辑器不开（那是写 markdown 源码）。
   */
  documentMode?: boolean;
  /** 卸载前把引用追踪的区间交出去（面板关闭 / 切页签后，重新打开要接着用） */
  onDestroy?: (snapshot: TrackedSnapshot) => void;
  /** 挂载后恢复的追踪区间（坐标在 `initialText` 里） */
  restoreTracked?: Record<string, { from: number; to: number }>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 回调放 ref：视图只建一次，之后回调怎么换都不用重建编辑器（重建会丢光标与撤销栈）
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    const hint = (): HTMLElement | undefined => {
      const text = callbacks.current.emptyHint;
      if (text === undefined) return undefined;
      const root = document.createElement("div");
      root.className = "dp-placeholder";
      const title = document.createElement("div");
      title.className = "dp-placeholder-title";
      title.textContent = text.title;
      const body = document.createElement("div");
      body.className = "dp-placeholder-body";
      body.textContent = text.body;
      root.append(title, body);
      return root;
    };

    const report = (view: EditorView): void => {
      const { from, to } = view.state.selection.main;
      if (from === to) {
        callbacks.current.onSelection(null);
        return;
      }
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to);
      if (start === null || end === null) {
        callbacks.current.onSelection(null);
        return;
      }
      // 同一行：取选区水平中点；跨行：取末端（浮条贴着松手的地方）
      const sameLine = Math.abs(start.top - end.top) < 2;
      callbacks.current.onSelection({
        from,
        to,
        docVersion: view.state.doc,
        rect: {
          x: sameLine ? (start.left + end.left) / 2 : end.left,
          top: Math.min(start.top, end.top),
          bottom: Math.max(start.bottom, end.bottom),
        },
      });
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: callbacks.current.initialText,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": callbacks.current.ariaLabel,
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          liveMarkdown(),
          quoteTracker(),
          ...(hint() === undefined ? [] : [placeholder(hint() as HTMLElement)]),
          ...(callbacks.current.documentMode === true ? [documentKeymap(), titleFirstFilter, titleAfterComposition()] : []),
          keymap.of([{ key: "Mod-b", run: toggleBold, preventDefault: true }, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            const external = update.transactions.some((tr) => tr.annotation(External) === true);
            if (update.docChanged && !external) callbacks.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged || update.geometryChanged) report(update.view);
          }),
        ],
      }),
    });

    const flash = (ranges: { from: number; to: number }[]): void => {
      if (ranges.length === 0) return;
      view.dispatch({ effects: flashRanges.of(ranges) });
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => view.dispatch({ effects: clearFlash.of(null) }), FLASH_MS);
    };

    for (const [id, range] of Object.entries(callbacks.current.restoreTracked ?? {})) {
      view.dispatch({ effects: trackRange.of({ id, from: range.from, to: range.to }) });
    }

    callbacks.current.handleRef.current = {
      applyChanges(changes, ranges) {
        if (changes.length > 0) {
          view.dispatch({
            changes: changes.map((change) => ({ from: change.from, to: change.to, insert: change.insert })),
            annotations: [External.of(true), Transaction.addToHistory.of(false)],
          });
        }
        flash(ranges);
      },
      setText(text, ranges = []) {
        const current = view.state.doc.toString();
        const changes = diffToChanges(current, text);
        if (changes.length > 0) {
          view.dispatch({
            changes: changes.map((change) => ({ from: change.from, to: change.to, insert: change.insert })),
            annotations: [External.of(true), Transaction.addToHistory.of(false)],
          });
        }
        flash(ranges);
      },
      getText: () => view.state.doc.toString(),
      command(name) {
        if (name === "heading") cycleHeading(view);
        else if (name === "bold") toggleBold(view);
        else if (name === "list") toggleList(view);
        else if (name === "undo") undo(view);
        else redo(view);
        view.focus();
      },
      focus: () => {
        view.focus();
      },
      trackQuote: (id, from, to, docVersion) => {
        // 选区是 SETTLE 延迟后才拿来登记的：这期间文档若变过（例如紧贴着打了同样的一句），
        // 这对坐标已经指到别处——登记了就是一个错的锚点。文本比对分不出（复制句和原句一字不差），只能比文档版本
        if (view.state.doc !== docVersion) return false;
        view.dispatch({ effects: trackRange.of({ id, from, to }) });
        return true;
      },
      trackedRange: (id) => view.state.field(quoteTrackField).get(id) ?? null,
      clearSelection: () => {
        view.dispatch({ selection: { anchor: view.state.selection.main.head } });
      },
    };

    return () => {
      if (flashTimer !== null) clearTimeout(flashTimer);
      callbacks.current.handleRef.current = null;
      const ranges: Record<string, { from: number; to: number }> = {};
      for (const [id, range] of view.state.field(quoteTrackField)) ranges[id] = { from: range.from, to: range.to };
      callbacks.current.onDestroy?.({ text: view.state.doc.toString(), ranges });
      view.destroy();
    };
    // 只建一次：换文档由父组件换 key 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="dp-editor" />;
}

