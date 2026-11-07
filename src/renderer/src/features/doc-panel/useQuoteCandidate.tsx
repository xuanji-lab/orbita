import { useCallback, useEffect, useRef, useState } from "react";
import type { TextQuote } from "@shared/quote";
import { QuoteToolbar, type QuoteCandidate } from "../../shell/QuoteToolbar";
import type { EditorSelectionInfo } from "./DocEditor";

/** 选区停稳多久才浮出工具栏：拖选过程中不跟着晃（对话里划选是 60ms 等选区落定，编辑器选区更碎，多等一拍） */
const SETTLE_MS = 240;

/** 浮条要的选区：源码偏移 + 视口位置（编辑器的选区带更多字段，结构兼容；阅读视图只给这几样） */
export type QuoteSelection = Pick<EditorSelectionInfo, "from" | "to" | "rect">;

/** 主槽输入框：引完回去接着写——引用就是为了下一句话 */
const focusComposer = (): void =>
  document.querySelector<HTMLTextAreaElement>(".pane-main textarea.composer-input")?.focus();

/**
 * 编辑器里划选 → 复用对话里那条划选工具栏（复制 / 引用）。这里只管「什么时候浮出来、引什么」：
 * `buildQuote` 把编辑器的选区折成一条文件引用（带行号 / 页号）与选区原文，由宿主视图给（文档与
 * 演示文稿的页内编辑器偏移基准不同）；工具栏本体是共用的 `QuoteToolbar`。
 *
 * 摘抄键不出现：摘抄的出处模型是「会话第几轮、谁说的」，一段文档里的话没有这两样，硬塞会在摘抄页签
 * 里显示成一条出处错的记录。
 */
export function useQuoteCandidate<S extends QuoteSelection = EditorSelectionInfo>(props: {
  buildQuote: (selection: S) => { quote: TextQuote; raw: string } | null;
  /** 缺席 = 没有输入框可引（工具栏只剩复制） */
  onQuote?: (quote: TextQuote) => void;
  clearSelection: () => void;
}): { onSelection: (selection: S | null) => void; dismiss: () => void; toolbar: React.ReactNode } {
  const [candidate, setCandidate] = useState<QuoteCandidate | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  const onSelection = useCallback((selection: S | null): void => {
    window.clearTimeout(timer.current);
    setCandidate((current) => (current === null ? current : null));
    if (selection === null) return;
    timer.current = window.setTimeout(() => {
      const built = latest.current.buildQuote(selection);
      if (built === null) return;
      setCandidate({ ...built, x: selection.rect.x, top: selection.rect.top, bottom: selection.rect.bottom });
    }, SETTLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const dismiss = useCallback(() => setCandidate(null), []);
  const clear = useCallback(() => latest.current.clearSelection(), []);
  const quote = useCallback((value: TextQuote): void => {
    latest.current.onQuote?.(value);
    focusComposer();
  }, []);

  const toolbar =
    candidate === null ? null : (
      <QuoteToolbar
        candidate={candidate}
        onDismiss={dismiss}
        onClearSelection={clear}
        {...(props.onQuote === undefined ? {} : { onQuote: quote })}
      />
    );
  return { onSelection, dismiss, toolbar };
}
