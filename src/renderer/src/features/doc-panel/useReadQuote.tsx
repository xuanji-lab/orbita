import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { TextQuote } from "@shared/quote";
import { quoteOfSelection } from "./doc-quote.ts";
import { sourceRangeOfSelection, type BlockLines } from "./read-quote.ts";
import { useQuoteCandidate, type QuoteSelection } from "./useQuoteCandidate";

/** 块级元素上的源码行标记（shared/ofm/rehype-source-lines.ts 打的） */
function blockLines(el: Element | null): BlockLines | null {
  const block = el?.closest("[data-sl]") ?? null;
  if (block === null) return null;
  const sl = Number(block.getAttribute("data-sl"));
  const end = Number(block.getAttribute("data-el"));
  return Number.isInteger(sl) && Number.isInteger(end) ? { sl, el: end } : null;
}

/** 选区覆盖的、有可见文字的第一个 / 最后一个文本节点（三击选段时终点落在下一块块首，按「相交」判定避开它） */
function edgeTextNodes(root: Element, range: Range): { first: Text; last: Text } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first: Text | null = null;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || (node.textContent ?? "").trim() === "") continue;
    first ??= node as Text;
    last = node as Text;
  }
  return first === null || last === null ? null : { first, last };
}

/**
 * 阅读视图里划选 → 复用编辑视图那条划选浮条（复制 / 引用），引用芯片是「文件名 · 第几行」。
 * 渲染出来的文字映射回源码靠块上的 data-sl / data-el（见 read-quote.ts）：引用拿到的是源码原文与行号，
 * 与编辑视图里划选得到的引用同一种形态。属性表等没有源码位置的区域划选不出浮条。
 */
export function useReadQuote(props: {
  path: string;
  /** 整份 markdown 源码 */
  text: string;
  onQuote?: (quote: TextQuote) => void;
  /** 滚动容器：滚动时浮条不跟着走，收起 */
  scrollRef: RefObject<HTMLElement | null>;
}): React.ReactNode {
  const { path, scrollRef } = props;
  const latest = useRef(props);
  latest.current = props;

  const buildQuote = useCallback(
    (selection: QuoteSelection) => {
      const { text } = latest.current;
      const quote = quoteOfSelection({ path, text, from: selection.from, to: selection.to });
      return quote === null ? null : { quote, raw: text.slice(selection.from, selection.to) };
    },
    [path],
  );
  const { onSelection, dismiss, toolbar } = useQuoteCandidate<QuoteSelection>({
    buildQuote,
    clearSelection: () => window.getSelection()?.removeAllRanges(),
    ...(props.onQuote === undefined ? {} : { onQuote: props.onQuote }),
  });

  useEffect(() => {
    const onChange = (): void => {
      const root = scrollRef.current?.querySelector(".dp-read") ?? null;
      const selection = window.getSelection();
      if (root === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        onSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        onSelection(null);
        return;
      }
      const edges = edgeTextNodes(root, range);
      const a = blockLines(edges?.first.parentElement ?? null);
      const b = blockLines(edges?.last.parentElement ?? null);
      if (a === null || b === null) {
        onSelection(null);
        return;
      }
      const [start, end] = a.sl <= b.sl ? [a, b] : [b, a];
      const found = sourceRangeOfSelection(latest.current.text, start, end, selection.toString());
      if (found === null) {
        onSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      onSelection({ ...found, rect: { x: rect.x + rect.width / 2, top: rect.top, bottom: rect.bottom } });
    };
    document.addEventListener("selectionchange", onChange);
    const scroller = scrollRef.current;
    scroller?.addEventListener("scroll", dismiss, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", onChange);
      scroller?.removeEventListener("scroll", dismiss);
    };
  }, [onSelection, dismiss, scrollRef]);

  return toolbar;
}
