/**
 * 「源码」视图：markdown 原文，等宽、不收起任何符号——只把标记符号 / 链接地址调成次级色、
 * 标题行加粗，免得一整片纯黑。与 `liveMarkdown()` 二选一（DocEditor 的 Compartment 切换，光标与撤销栈不丢）。
 * 不引 @lezer/highlight：直接按语法树节点名上 class，颜色全在 CSS（只用 token）。
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const DIM = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "LinkMark", "QuoteMark", "ListMark", "URL", "CodeInfo"]);
const dim = Decoration.mark({ class: "cm-syntax" });
const headingLine = Decoration.line({ class: "cm-src-h" });

function build(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (DIM.has(node.name)) out.push(dim.range(node.from, node.to));
        else if (/^(?:ATX|Setext)Heading\d$/.test(node.name)) out.push(headingLine.range(view.state.doc.lineAt(node.from).from));
      },
    });
  }
  return Decoration.set(out, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  },
  { decorations: (value) => value.decorations },
);

export function sourceMarkdown() {
  return [markdown({ base: markdownLanguage, addKeymap: false }), plugin];
}
