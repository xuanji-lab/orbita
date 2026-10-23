/**
 * LaTeX 源码编辑器（CodeMirror 6）的语言与外观配置。
 *
 * **为什么用 SteamLanguage + legacy-modes/stex**：上游没有维护良好的官方 LaTeX 语言包，
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
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
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
