/**
 * LaTeX 源码编辑器（CodeMirror 6）的语言与外观配置。
 *
 * **为什么用 StreamLanguage + legacy-modes/stex**：上游没有维护良好的官方 LaTeX 语言包，
 * @codemirror/legacy-modes 的 stex 是 CodeMirror 5 的成熟词法器（命令、注释、数学模式、
 * \begin/\end 参数都认），由官方维护者移植到 CM6，体积只有几 KB。不引入第三方
 * 「codemirror-lang-latex」一类包（维护状态不明，且要自己带一套 Lezer grammar）。
 *
 * **不懒加载**：AGENTS.md 禁 inline import（`await import()`），CodeMirror 从顶层
 * import 进来，跟着 renderer bundle 一起打包——面板第一次打开 .tex 不需要等分包。
 *
 * 排版默认（LaTeX 社区的通行写法，写在这里而不是散在组件里）：
 * - 缩进 **2 个空格**（`indentUnit` + `EditorState.tabSize`），Tab 键插入缩进而不是制表符；
 * - **软换行**开启：右栏通常只有几百像素宽，不折行会逼着横向滚动读源码；
 * - 行号、当前行高亮、括号匹配、搜索（Ctrl/Cmd+F）。
 */
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags } from "@lezer/highlight";

/** LaTeX 语言：stex 词法器（命令 / 注释 / 数学模式 / 环境名） */
export const latexLanguage = StreamLanguage.define(stex);

/**
 * 只读开关。agent 正在写这个文件时整块关掉：`readOnly` 挡的是所有会改文档的事务
 * （含粘贴与 Ctrl+Z），`editable(false)` 再让光标与输入框从 DOM 上消失——两者都要，
 * 只有前者时看着还能打字、后者的拦截在拖放上又不够。
 *
 * 做成 Compartment 是因为「回合进行中」是个随时翻转的外部状态，
 * 而重建编辑器会丢掉光标与撤销历史。
 */
export const readOnlyCompartment = new Compartment();

export function readOnlyExtensions(readOnly: boolean): Extension[] {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

/** 换掉「agent 改动块」的高亮范围（每次回合落定 / 每撤一块算一次） */
const setAgentMarks = StateEffect.define<DecorationSet>();

/**
 * agent 本轮新增的行的底色。**用 StateField 而不是静态 facet**：用户继续编辑时，
 * 底色要跟着文字走（`map(tr.changes)`），否则一次回车就把高亮错到别处去。
 */
const agentMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setAgentMarks)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 把一组字符区间换成「agent 改动」高亮事务（区间可以不按顺序给） */
export function agentMarkEffect(ranges: readonly { from: number; to: number }[]): StateEffect<DecorationSet> {
  const sorted = [...ranges].filter((range) => range.to > range.from).sort((a, b) => a.from - b.from);
  return setAgentMarks.of(
    Decoration.set(
      sorted.map((range) => Decoration.mark({ class: "cm-agent-hunk" }).range(range.from, range.to)),
      true,
    ),
  );
}

/** 换掉「SyncTeX 定位到的那一行」的高亮范围（PDF 双击 / 右键在 PDF 中定位的结果） */
const setSyncLine = StateEffect.define<DecorationSet>();

/**
 * 与 agentMarks 同一套 StateField（用户一打字就跟着文字走，不会错行）：
 * **整行底色**用 line 装饰而不是 mark——定位的是「这一行」，不是某段文字。
 */
const syncLineMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setSyncLine)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * 高亮一行。行装饰（Decoration.line）的区间**必须是零长**（CodeMirror 的硬约束：
 * 传 from..to 会抛 "Line decoration ranges must be zero-length" 并掀翻整个编辑器），
 * 只接受行的起点；1 基行号的换算在调用方。
 */
export function syncLineEffect(from: number): StateEffect<DecorationSet> {
  return setSyncLine.of(Decoration.set([Decoration.line({ class: "cm-sync-line" }).range(from)], true));
}

/** 清掉定位高亮（TexEditorPane 在 2 秒后发这发，短暂停留是为了让人看见「跳到哪了」） */
export function clearSyncLineEffect(): StateEffect<DecorationSet> {
  return setSyncLine.of(Decoration.none);
}

/**
 * 语法着色只写 token，不写颜色值：深浅主题、纸面主题都按同一份 CSS 变量走。
 * 变量在 styles.css 的 `.tex-editor` 作用域里声明（见那里的说明）。
 */
const latexHighlight = HighlightStyle.define([
  // \section / \cite / \begin 这类命令：字重区分，不抢 accent（accent 只给主操作）
  { tag: tags.tagName, color: "var(--tex-cmd)", fontWeight: "600" },
  // 命令的参数：\begin{...} 的环境名、\cite 的 key
  { tag: tags.atom, color: "var(--tex-argument)" },
  { tag: tags.string, color: "var(--tex-argument)" },
  { tag: tags.keyword, color: "var(--tex-math)" },
  // 数学模式里的字母 / 数字
  { tag: tags.variableName, color: "var(--tex-math)" },
  { tag: tags.number, color: "var(--tex-number)" },
  { tag: tags.bracket, color: "var(--color-text-secondary)" },
  { tag: tags.brace, color: "var(--color-text-secondary)" },
  { tag: tags.comment, color: "var(--tex-comment)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--color-danger)" },
]);

export function latexEditorExtensions(onUpdate: (update: { docChanged: boolean; selectionSet: boolean }) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    rectangularSelection(),
    highlightActiveLine(),
    bracketMatching(),
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    latexLanguage,
    syntaxHighlighting(latexHighlight),
    readOnlyCompartment.of(readOnlyExtensions(false)),
    agentMarks,
    syncLineMarks,
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return;
      onUpdate({ docChanged: update.docChanged, selectionSet: update.selectionSet });
    }),
    EditorView.theme({
      "&": {
        height: "100%",
        fontSize: "var(--font-size-sm)",
        backgroundColor: "transparent",
        color: "var(--color-text-primary)",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: "var(--font-family-mono)",
        lineHeight: "var(--line-height-code-block)",
        overflow: "auto",
      },
      ".cm-content": {
        padding: "var(--space-2) 0",
        caretColor: "var(--color-text-primary)",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--color-text-tertiary)",
        border: "none",
        paddingLeft: "var(--space-2)",
      },
      ".cm-activeLine": { backgroundColor: "var(--color-bg-muted)" },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--color-text-secondary)",
      },
      ".cm-cursor": { borderLeftColor: "var(--color-text-primary)" },
      ".cm-matchingBracket": {
        backgroundColor: "var(--color-accent-soft)",
        outline: "1px solid var(--color-border-strong)",
      },
      ".cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--color-accent-soft)",
      },
      ".cm-searchMatch": {
        backgroundColor: "var(--color-accent-soft)",
        outline: "1px solid var(--color-border-strong)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "var(--color-bg-active)",
      },
      // agent 本轮新增的行：成功色的很低一档（同一色也用于 git additions / 编辑器徽标）。
      // 只铺新增的行，上下文行不涂——「改了哪儿」不能被涂成「改了五行」
      ".cm-agent-hunk": {
        backgroundColor: "var(--color-success-soft)",
        borderRadius: "2px",
      },
      // PDF → 源码的落点：accent 的低一档底色，短暂停留（与 PDF 里的落点框同色系）
      ".cm-sync-line": {
        backgroundColor: "var(--color-accent-soft)",
      },
      ".cm-panels": {
        backgroundColor: "var(--color-bg-panel)",
        color: "var(--color-text-primary)",
      },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border-subtle)" },
      ".cm-textfield": {
        backgroundColor: "var(--color-bg-app)",
        color: "var(--color-text-primary)",
        border: "1px solid var(--color-border-default)",
      },
      ".cm-button": {
        backgroundColor: "var(--color-bg-muted)",
        color: "var(--color-text-primary)",
        backgroundImage: "none",
        border: "1px solid var(--color-border-subtle)",
      },
    }),
  ];
}
