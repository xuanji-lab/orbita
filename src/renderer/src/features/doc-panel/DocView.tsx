import { useCallback, useEffect, useRef } from "react";
import type { TextQuote } from "@shared/quote";
import { useT } from "../../locale.ts";
import { DocEditor, type DocEditorHandle, type EditorSelectionInfo } from "./DocEditor";
import type { DocSession, ExternalChange } from "./doc-session.ts";
import { quoteOfSelection } from "./doc-quote.ts";
import { useQuoteCandidate } from "./useQuoteCandidate";

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
      return quote === null ? null : { quote, raw: text.slice(selection.from, selection.to) };
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
        />
      </div>
      {toolbar}
    </div>
  );
}
