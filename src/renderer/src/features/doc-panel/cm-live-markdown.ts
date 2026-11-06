/**
 * 文档编辑器的「所见即所得式」markdown 外观（CodeMirror 6 扩展）。
 *
 * 文档的真身是 markdown 源码（agent 用 read / edit 就能改），但用户看到的是文档：
 * 标题放大、加粗变粗、列表前是圆点——**光标不在的地方**，`#` / `**` / `` ` `` 这些符号被收起；
 * 光标走到那一行 / 那一段，符号回来，用户总能看见并改自己写的是什么。
 *
 * 只做装饰（line / mark / replace），不改文档内容、不改选区语义：所以引用拿到的永远是
 * 源码里的原文（agent 用 edit 工具能逐字对上），行号也始终是文件里的行号。
 * 只在可见区间里建装饰（长文档 5 万字不为屏幕外的内容付费）。
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
  eq(): boolean {
    return true;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });
const hidden = Decoration.replace({});

const HEADING = /^(?:ATX|Setext)Heading(\d)$/;
const headingLine = [1, 2, 3, 4, 5, 6].map((level) => Decoration.line({ class: `cm-h cm-h${level}` }));
const strong = Decoration.mark({ class: "cm-strong" });
const emphasis = Decoration.mark({ class: "cm-em" });
const inlineCode = Decoration.mark({ class: "cm-icode" });
const linkText = Decoration.mark({ class: "cm-link" });
const dimMark = Decoration.mark({ class: "cm-syntax" });
const listLine = Decoration.line({ class: "cm-li" });
const quoteLine = Decoration.line({ class: "cm-quote" });
const codeLine = Decoration.line({ class: "cm-codeblock" });
const ruleLine = Decoration.line({ class: "cm-rule" });
const blankLine = Decoration.line({ class: "cm-blank" });
const dimLine = Decoration.line({ class: "cm-dim" });

/** 选区所在的行号集合与区间（用来决定哪里的标记要露出来） */
function touched(state: EditorState, focused: boolean): { lines: Set<number>; ranges: { from: number; to: number }[] } {
  const lines = new Set<number>();
  // 编辑器没有焦点时没有「光标所在」：符号一律收起（开着文档去看别处时它读起来就是一份文档）
  if (!focused) return { lines, ranges: [] };
  const ranges = state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
  for (const range of ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n += 1) lines.add(n);
  }
  return { lines, ranges };
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const { lines: activeLines, ranges: selections } = touched(state, view.hasFocus);
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  // 同一行同一种行装饰只加一次（一个列表项里多个节点都会撞到同一行）
  const lineSeen = new Map<Decoration, Set<number>>();
  const lineDeco = (from: number, deco: Decoration): void => {
    const line = doc.lineAt(from);
    const seen = lineSeen.get(deco) ?? new Set<number>();
    lineSeen.set(deco, seen);
    if (seen.has(line.number)) return;
    seen.add(line.number);
    out.push(deco.range(line.from));
  };
  // 光标所在的那一段（连续非空行）：专注写作纸面里其余段落降低不透明度（只在编辑器有焦点时生效，CSS 管）
  const head = doc.lineAt(state.selection.main.head).number;
  let paraFirst = head;
  let paraLast = head;
  if (doc.line(head).length > 0) {
    while (paraFirst > 1 && doc.line(paraFirst - 1).length > 0) paraFirst -= 1;
    while (paraLast < doc.lines && doc.line(paraLast + 1).length > 0) paraLast += 1;
  }
  const near = (from: number, to: number): boolean => selections.some((s) => s.from <= to && s.to >= from);

  for (const { from, to } of view.visibleRanges) {
    // 段落序号（瑞士网格纸面的左侧标签列用，CSS 读 data-para；别的纸面不显示）：
    // 先数出可见区间之前有几段，再往下数——行在屏外时 DOM 里没有，不能让 CSS 计数器去数
    let para = 0;
    for (let n = 1, prevBlank = true; n < doc.lineAt(from).number; n += 1) {
      const blank = doc.line(n).length === 0;
      if (!blank && prevBlank) para += 1;
      prevBlank = blank;
    }
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      // 空行收成固定小间距（含光标所在的那一行——光标进出一个空行不该让版面跳一下）
      if (line.length === 0) out.push(blankLine.range(line.from));
      else if (line.number < paraFirst || line.number > paraLast) out.push(dimLine.range(line.from));
      if (line.length > 0 && (line.number === 1 || doc.line(line.number - 1).length === 0)) {
        para += 1;
        out.push(Decoration.line({ attributes: { "data-para": String(para).padStart(2, "0") } }).range(line.from));
      }
      pos = line.to + 1;
    }
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = HEADING.exec(name);
        if (heading !== null) {
          lineDeco(node.from, headingLine[Number(heading[1]) - 1] as Decoration);
          return;
        }
        switch (name) {
          case "HeaderMark": {
            const line = doc.lineAt(node.from);
            if (activeLines.has(line.number)) {
              out.push(dimMark.range(node.from, node.to));
            } else if (line.text.startsWith("#")) {
              // 收起 `# ` 连同后面的空格
              const end = Math.min(node.to + 1, line.to);
              out.push(hidden.range(node.from, end));
            }
            return;
          }
          case "StrongEmphasis":
            out.push(strong.range(node.from, node.to));
            return;
          case "Emphasis":
            out.push(emphasis.range(node.from, node.to));
            return;
          case "InlineCode":
            out.push(inlineCode.range(node.from, node.to));
            return;
          case "EmphasisMark":
          case "CodeMark": {
            // 围栏代码块的 ``` 也叫 CodeMark：它在 FencedCode 里整行显示，不收
            const parent = node.node.parent;
            if (parent === null || parent.name === "FencedCode") return;
            if (near(parent.from, parent.to)) out.push(dimMark.range(node.from, node.to));
            else out.push(hidden.range(node.from, node.to));
            return;
          }
          case "Link":
            out.push(linkText.range(node.from, node.to));
            return;
          case "ListMark": {
            const line = doc.lineAt(node.from);
            lineDeco(node.from, listLine);
            const text = doc.sliceString(node.from, node.to);
            if (/^[-*+]$/.test(text) && !activeLines.has(line.number)) out.push(bullet.range(node.from, node.to));
            else out.push(dimMark.range(node.from, node.to));
            return;
          }
          case "Blockquote": {
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(Math.min(node.to, doc.length)).number;
            for (let n = first; n <= last; n += 1) lineDeco(doc.line(n).from, quoteLine);
            return;
          }
          case "QuoteMark": {
            const line = doc.lineAt(node.from);
            if (activeLines.has(line.number)) out.push(dimMark.range(node.from, node.to));
            else out.push(hidden.range(node.from, Math.min(node.to + 1, line.to)));
            return;
          }
          case "FencedCode":
          case "CodeBlock": {
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(Math.min(node.to, doc.length)).number;
            for (let n = first; n <= last; n += 1) lineDeco(doc.line(n).from, codeLine);
            return;
          }
          case "HorizontalRule":
            lineDeco(node.from, ruleLine);
            return;
          default:
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const livePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** agent 新增 / 改动的区间：整行标绿边，几秒后淡出（CSS 动画，清除时无跳变） */
export const flashRanges = StateEffect.define<{ from: number; to: number }[]>();
export const clearFlash = StateEffect.define<null>();
const flashLine = Decoration.line({ class: "cm-agent-new" });

export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(clearFlash)) next = Decoration.none;
      if (effect.is(flashRanges)) {
        const marks: Range<Decoration>[] = [];
        const seen = new Set<number>();
        for (const range of effect.value) {
          let from = Math.min(range.from, tr.state.doc.length);
          let to = Math.min(range.to, tr.state.doc.length);
          // 插入常以换行起头（接在上一段末尾）：那几个换行属于上一段的行尾，不算新增的段
          while (from < to && tr.state.doc.sliceString(from, from + 1) === "\n") from += 1;
          while (to > from && tr.state.doc.sliceString(to - 1, to) === "\n") to -= 1;
          const first = tr.state.doc.lineAt(from).number;
          // 范围末尾恰好是一行开头（插入以换行结尾）时，那一行不算
          const endPos = to > from && tr.state.doc.lineAt(to).from === to ? to - 1 : to;
          const last = tr.state.doc.lineAt(endPos).number;
          for (let n = first; n <= last; n += 1) {
            if (seen.has(n)) continue;
            seen.add(n);
            const line = tr.state.doc.line(n);
            // 空行不标（段与段之间的空行不是「新增的段」）
            if (line.length > 0) marks.push(flashLine.range(line.from));
          }
        }
        next = next.update({ add: marks, sort: true });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** markdown 语言 + 所见即所得外观 */
export function liveMarkdown() {
  return [markdown({ base: markdownLanguage }), livePlugin, flashField];
}
