import { useCallback, useEffect, useRef, useState } from "react";
import { parseDeck, serializeDeck, type Deck } from "../../../../shared/slides.ts";
import type { DocSession, ExternalChange } from "../doc-panel/doc-session.ts";
import { createHistory, pushState, redo as redoState, replacePresent, undo as undoState, type History } from "./history.ts";
import { mergeDeckTexts } from "./deck-merge.ts";
import type { MergeFn } from "../doc-panel/doc-session.ts";

/** 演示文稿的合并函数：交给 DocSession（结构级三向合并，见 deck-merge.ts） */
export const deckMerge: MergeFn = (base, local, disk) => ({
  text: serializeDeck(mergeDeckTexts(base, local, disk)),
  changes: [],
  inserted: [],
});

export function parseDeckSafe(text: string): { deck: Deck; error: string | null } {
  try {
    return { deck: parseDeck(text).deck, error: null };
  } catch (cause) {
    return { deck: { version: 1, title: "", aspect: "16:9", slides: [] }, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface DeckEditor {
  deck: Deck;
  /** 改动：入撤销栈并写进会话（防抖落盘）。coalesceKey 相同的连续改动合并成一步 */
  commit: (next: Deck, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * 演示文稿的编辑状态：不可变 Deck 的快照栈 + DocSession 的落盘与外部合并。
 * 文本只在**提交时**序列化（拖动中的位置在画布的 draft 里，不进这里）。
 * agent 的写入经 DocSession 合并后从 `externalRef` 回调进来，作为新的一步入栈（撤销能回到它之前）。
 */
export function useDeckEditor(session: DocSession, initialText: string, externalRef: { current: (change: ExternalChange) => void }): DeckEditor {
  const [history, setHistory] = useState<History<Deck>>(() => createHistory(parseDeckSafe(initialText).deck));
  const ref = useRef(history);
  ref.current = history;

  const apply = useCallback(
    (next: History<Deck>, write: boolean): void => {
      if (next === ref.current) return;
      const deckChanged = next.present !== ref.current.present;
      ref.current = next;
      setHistory(next);
      if (write && deckChanged) session.edit(serializeDeck(next.present));
    },
    [session],
  );

  const commit = useCallback((next: Deck, coalesceKey?: string): void => apply(pushState(ref.current, next, Date.now(), coalesceKey), true), [apply]);
  const undo = useCallback((): void => apply(undoState(ref.current), true), [apply]);
  const redo = useCallback((): void => apply(redoState(ref.current), true), [apply]);

  useEffect(() => {
    externalRef.current = (change) => {
      const parsed = parseDeckSafe(change.text);
      if (parsed.error !== null) return;
      apply(replacePresent(ref.current, parsed.deck), false);
    };
    return () => {
      externalRef.current = () => undefined;
    };
  }, [externalRef, apply]);

  return { deck: history.present, commit, undo, redo, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}
