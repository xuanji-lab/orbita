import { useCallback, useEffect, useRef } from "react";
import type { TextQuote } from "@shared/quote";
import { useT } from "../../locale.ts";
import { DocEditor, type DocEditorHandle, type EditorSelectionInfo } from "./DocEditor";
import type { DocSession, ExternalChange } from "./doc-session.ts";
import { quoteOfSelection } from "./doc-quote.ts";
import { useQuoteCandidate } from "./useQuoteCandidate";
import { getView, setView } from "./view-memory.ts";

/** 文档视图：一页纸 + 所见即所得式的 markdown 编辑器。agent 的改动按最小差异并进来，新增的行标绿边 */
export function DocView(props: {
  session: DocSession;
  path: string;
  initialText: string;
  handleRef: { current: DocEditorHandle | null };
  externalRef: { current: (change: ExternalChange) => void };
  onQuote?: (quote: TextQuote) => void;
}) {
  const t = useT();
  const { session, path, handleRef, externalRef } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const anchorSeq = useRef(0);

  // 滚动位置：回到上次停的地方；滚动时（防抖）与卸载时记下
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return undefined;
    const saved = getView(path).scroll ?? 0;
    let frame = 0;
    if (saved > 0) {
      // 编辑器内容排好版才有高度：等两帧再设
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          scroller.scrollTop = saved;
        });
      });
    }
    let timer: number | undefined;
    const remember = (): void => setView(path, { scroll: Math.round(scroller.scrollTop) });
    const onScroll = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(remember, 300);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
      // 卸载时 scrollTop 可能已被清零（节点已脱离），只在还有值时记
      if (scroller.scrollTop > 0 || saved === 0) remember();
    };
  }, [path]);

  // 外部合并：按合并给出的改动直接改编辑器（光标由 CodeMirror 映射），新增区间标绿
  useEffect(() => {
    externalRef.current = (change) => handleRef.current?.applyChanges(change.changes, change.inserted);
    return () => {
      externalRef.current = () => undefined;
    };
  }, [externalRef, handleRef]);

  const buildQuote = useCallback(
    (selection: EditorSelectionInfo) => {
      const text = session.text;
      const quote = quoteOfSelection({ path, text, from: selection.from, to: selection.to });
      if (quote === null) return null;
      // 登记区间：发送前编辑器怎么改，这段的位置都跟着走（重复句时靠它分得清是哪一处）
      anchorSeq.current += 1;
      const anchor = `q${anchorSeq.current}`;
      handleRef.current?.trackQuote(anchor, selection.from, selection.to);
      return { quote: { ...quote, anchor }, raw: text.slice(selection.from, selection.to) };
    },
    [session, path],
  );
  const { onSelection, dismiss, toolbar } = useQuoteCandidate({
    buildQuote,
    clearSelection: () => handleRef.current?.clearSelection(),
    ...(props.onQuote === undefined ? {} : { onQuote: props.onQuote }),
  });

  // 滚动时浮条不跟着走：收起
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return undefined;
    scroller.addEventListener("scroll", dismiss, { passive: true });
    return () => scroller.removeEventListener("scroll", dismiss);
  }, [dismiss]);

  return (
    <div className="dp-scroll" ref={scrollRef}>
      <div className="dp-page">
        <DocEditor
          initialText={props.initialText}
          onChange={(text) => session.edit(text)}
          onSelection={onSelection}
          emptyHint={{ title: t.doc.titlePlaceholder, body: t.doc.bodyPlaceholder }}
          handleRef={handleRef}
          ariaLabel={t.doc.editorLabel}
          documentMode
        />
      </div>
      {toolbar}
    </div>
  );
}
