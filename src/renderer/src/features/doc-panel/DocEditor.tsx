import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { clearFlash, flashRanges, liveMarkdown } from "./cm-live-markdown.ts";
import { diffToChanges, type TextChange } from "./doc-merge.ts";
import { cycleHeading, toggleBold, toggleList } from "./doc-commands.ts";

/** 编辑器里一次选区（偏移按编辑器自己的文本算） */
export interface EditorSelectionInfo {
  from: number;
  to: number;
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
}

/** 外部改动（agent / 重新对齐）的事务打这个标：不回报给 onChange、不进撤销栈 */
const External = Annotation.define<boolean>();

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
          ...(hint() === undefined ? [] : [placeholder(hint() as HTMLElement)]),
          keymap.of([
            { key: "Mod-b", run: toggleBold, preventDefault: true },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
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
      clearSelection: () => {
        view.dispatch({ selection: { anchor: view.state.selection.main.head } });
      },
    };

    return () => {
      if (flashTimer !== null) clearTimeout(flashTimer);
      callbacks.current.handleRef.current = null;
      view.destroy();
    };
    // 只建一次：换文档由父组件换 key 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="dp-editor" />;
}

