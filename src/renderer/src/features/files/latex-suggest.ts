/**
 * LaTeX 补全的**纯逻辑**（`node --test` 覆盖）：光标现场是什么（命令 / 环境 / 引用 /
 * 路径 / snippet），以及该给哪些候选。CodeMirror 的接线在 latex-completion.ts，
 * 那一层只把这里的结论换成 `Completion` 对象。
 *
 * 五个现场各自一条正则，**顺序即优先级**（先长后短）：`\begin{` 不该被命令分支吃掉，
 * `\ref{` 不该被路径分支吃掉。正则都要求「光标前没有闭合的 `}`」——已经写完的参数不是
 * 正在输入的现场。
 *
 * 数据三层：
 * - 静态命令 / 环境 / snippet：latex-data.ts（LaTeX-Workshop 的 MIT 数据）
 * - 项目索引：`\label` 候选、项目自定义命令 / 环境、路径候选（主进程 `latex:index`）
 * - 文献库：`\cite` 走 cite-suggest.ts（本文件不碰，它已有自己的测试）
 *
 * **过滤自己做（CompletionResult.filter = false）**：按标题 / 路径匹配的候选让 CodeMirror
 * 再按 label 筛一遍会被筛掉——`fig/pl` 命中 `figures/plot.pdf` 的那条就活不下来。
 */
import type { LatexLabelRef, LatexProjectIndex } from "../../../../shared/latex.ts";
import {
  LATEX_COMMAND_DATA,
  LATEX_ENVIRONMENT_DATA,
  LATEX_SNIPPET_DATA,
  type LatexCommandData,
} from "./latex-data.ts";
import { inTexComment } from "./tex-text.ts";

/** 光标前的补全现场。`from` 是本次候选替换的起点（传入文本里的下标） */
export type LatexContext =
  | { kind: "command"; from: number; query: string }
  | { kind: "environment"; from: number; query: string; mode: "begin" | "end" }
  | { kind: "reference"; from: number; query: string }
  | { kind: "path"; from: number; query: string; mode: "tex" | "graphics" | "bib" }
  | { kind: "snippet"; from: number; query: string };

/** 候选：`text` 是插入内容（snippet 模板或纯文本），由接线层决定用哪种插入方式 */
export interface LatexSuggestion {
  kind: "command" | "environment" | "reference" | "path" | "snippet";
  /** 候选行显示的名字（也是筛选匹配的对象） */
  label: string;
  /** 行右侧的一句话 */
  detail: string | null;
  /** 选中时才显示的补充说明 */
  info: string | null;
  /** plain = 直接插入；snippet = 走 CodeMirror 的字段语法（`${1:...}`） */
  insert: "plain" | "snippet";
  text: string;
}

/** 一次最多给几条：弹层只渲染 24 行，再长就该多打两个字 */
const LIMIT = 60;

/**
 * 会接 `{...}` 的引用命令（natbib / biblatex / hyperref / cleveref 的常见写法）。
 * 显式名单而不是 `\*ref.*`：`\refstepcounter` 这类命令不该弹 label 列表。
 */
const REFERENCE_COMMANDS = [
  "ref",
  "eqref",
  "pageref",
  "nameref",
  "autoref",
  "Autoref",
  "cref",
  "Cref",
  "cpageref",
  "Cpageref",
  "labelcref",
  "vref",
  "Vref",
  "subref",
] as const;

/** 会接文件参数的路径命令 → 候选的类别 */
const PATH_COMMANDS: readonly { name: string; mode: "tex" | "graphics" | "bib" }[] = [
  { name: "input", mode: "tex" },
  { name: "include", mode: "tex" },
  { name: "subfile", mode: "tex" },
  { name: "includegraphics", mode: "graphics" },
  { name: "includesvg", mode: "graphics" },
  { name: "lstinputlisting", mode: "tex" },
  { name: "bibliography", mode: "bib" },
  { name: "addbibresource", mode: "bib" },
];

const ENV_BEGIN = /\\begin\s*\{([^{}]*)$/;
const ENV_END = /\\end\s*\{([^{}]*)$/;
const REFERENCE = new RegExp(
  `\\\\(?:${REFERENCE_COMMANDS.join("|")})\\*?[ \\t]*\\{([^{}]*)$`,
);
const PATH = new RegExp(
  `\\\\(?:${PATH_COMMANDS.map((entry) => entry.name).join("|")})\\*?[ \\t]*(?:\\[[^\\]\\n]*\\][ \\t]*)?\\{([^{}]*)$`,
);
const COMMAND = /\\[A-Za-z@]*$/;
/** snippet 的触发词：不含反斜杠 / 花括号 / 空白的「词」 */
const WORD = /[^\s\\{}]+$/;

/**
 * 光标前的现场。不在现场（普通文字、注释里、已经闭合的参数）回 null。
 *
 * 注释判定只看**同一行**：`% \cite{` 不该弹，`\% \ref{` 里那个百分号是字面量。
 */
export function latexContextBefore(text: string): LatexContext | null {
  const env = ENV_BEGIN.exec(text);
  if (env !== null && !commentAt(text, env)) {
    return { kind: "environment", from: (env.index ?? 0) + env[0].length - (env[1] ?? "").length, query: env[1] ?? "", mode: "begin" };
  }
  const end = ENV_END.exec(text);
  if (end !== null && !commentAt(text, end)) {
    return { kind: "environment", from: (end.index ?? 0) + end[0].length - (end[1] ?? "").length, query: end[1] ?? "", mode: "end" };
  }
  const reference = REFERENCE.exec(text);
  if (reference !== null && !commentAt(text, reference)) {
    return { kind: "reference", from: (reference.index ?? 0) + reference[0].length - (reference[1] ?? "").length, query: reference[1] ?? "" };
  }
  const path = PATH.exec(text);
  if (path !== null && !commentAt(text, path)) {
    const command = /^\\([A-Za-z]+)/.exec(path[0])?.[1] ?? "";
    const mode = PATH_COMMANDS.find((entry) => entry.name === command)?.mode ?? "tex";
    return { kind: "path", from: (path.index ?? 0) + path[0].length - (path[1] ?? "").length, query: path[1] ?? "", mode };
  }
  const command = COMMAND.exec(text);
  if (command !== null) {
    const start = command.index ?? 0;
    // `\\frac` 是换行后的 "frac"，不是命令；`\%` 这类控制符号也不是命令名
    const before = start > 0 ? text[start - 1] : "";
    if (before === "\\") return null;
    if (!commentAt(text, command)) {
      return { kind: "command", from: start + 1, query: command[0].slice(1) };
    }
  }
  // snippet：必须在行内、非注释，且触发词本身是个「不像自然单词」的前缀（见 suggestSnippets）
  const word = WORD.exec(text);
  if (word !== null && !commentAt(text, word)) {
    const query = word[0];
    if (snippetPrefixes().some((prefix) => prefix.startsWith(query))) {
      return { kind: "snippet", from: (word.index ?? 0) + word[0].length - query.length, query };
    }
  }
  return null;
}

/** 命中的位置在不在注释里：`match.index` 属于匹配起点，检查该行到起点为止 */
function commentAt(text: string, match: RegExpExecArray): boolean {
  const start = match.index ?? 0;
  const lineStart = text.lastIndexOf("\n", start) + 1;
  return inTexComment(text.slice(lineStart, start + match[0].length), start - lineStart);
}

/* ------------------------------ 候选 ------------------------------ */

/** 空查询时先给这些（写论文最常用的命令），其余按字母序 */
const COMMON_COMMANDS = [
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "textbf",
  "textit",
  "emph",
  "underline",
  "frac",
  "sqrt",
  "cite",
  "ref",
  "label",
  "begin",
  "end",
  "item",
  "includegraphics",
  "caption",
  "centering",
  "footnote",
  "usepackage",
  "documentclass",
  "left",
  "right",
  "sum",
  "int",
  "alpha",
  "beta",
  "times",
  "cdot",
  "hline",
  "toprule",
  "midrule",
  "bottomrule",
];

/**
 * snippet 的触发词。**只收「不像自然单词」的前缀**：`item` / `figure` 这类前缀在英文
 * 正文里太常见，边打字边弹 `\item` 会把写散文变成拆弹；大写缩写（BEQ / FIG）与带符号的
 * （`__` / `...` / `**`）不会误伤。
 */
function snippetPrefixes(): readonly string[] {
  return LATEX_SNIPPET_DATA.filter(
    (snippet) => /^[A-Z]+$/.test(snippet.prefix) || /[^A-Za-z]/.test(snippet.prefix),
  ).map((snippet) => snippet.prefix);
}

const lower = (value: string): string => value.toLowerCase();

/** 现场 → 候选（已按相关度排好、已截断）。索引缺席时只有静态那一层 */
export function suggestLatex(
  context: LatexContext,
  index: LatexProjectIndex | null,
  limit: number = LIMIT,
): LatexSuggestion[] {
  switch (context.kind) {
    case "command":
      return suggestCommands(context.query, index, limit);
    case "environment":
      return suggestEnvironments(context, index, limit);
    case "reference":
      return suggestReferences(context.query, index, limit);
    case "path":
      return suggestPaths(context.query, context.mode, index, limit);
    case "snippet":
      return suggestSnippets(context.query, limit);
  }
}

function suggestCommands(query: string, index: LatexProjectIndex | null, limit: number): LatexSuggestion[] {
  const needle = lower(query);
  const rows: { suggestion: LatexSuggestion; rank: number }[] = [];
  const push = (data: LatexCommandData, projectDefined: boolean): void => {
    if (needle !== "" && !lower(data.name).includes(needle)) return;
    const rank = needle === "" ? COMMON_COMMANDS.indexOf(data.name) : lower(data.name).startsWith(needle) ? 0 : 1;
    rows.push({
      rank: rank < 0 ? COMMON_COMMANDS.length : rank,
      suggestion: {
        kind: "command",
        label: data.name,
        detail: projectDefined ? "本项目定义" : data.detail,
        info: data.doc,
        insert: "snippet",
        text: data.snippet,
      },
    });
  };
  for (const data of LATEX_COMMAND_DATA) push(data, false);
  // 项目自定义命令：不在静态表里的才补（同名以静态表的 snippet 为准）
  const known = new Set(LATEX_COMMAND_DATA.map((data) => data.name));
  for (const name of index?.commands ?? []) {
    if (known.has(name)) continue;
    push({ name, snippet: name, detail: "本项目定义", doc: null }, true);
  }
  rows.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : compareLabels(a.suggestion.label, b.suggestion.label)));
  return rows.slice(0, limit).map((row) => row.suggestion);
}

function suggestEnvironments(
  context: { mode: "begin" | "end"; query: string },
  index: LatexProjectIndex | null,
  limit: number,
): LatexSuggestion[] {
  const needle = lower(context.query);
  const rows: LatexSuggestion[] = [];
  const known = new Set(LATEX_ENVIRONMENT_DATA.map((data) => data.name));
  for (const data of LATEX_ENVIRONMENT_DATA) {
    if (needle !== "" && !lower(data.name).includes(needle)) continue;
    rows.push({
      kind: "environment",
      label: data.name,
      detail: data.detail,
      info: null,
      insert: "snippet",
      text: environmentInsertion(context.mode, data.name, data.snippet),
    });
  }
  for (const name of index?.environments ?? []) {
    if (known.has(name)) continue;
    if (needle !== "" && !lower(name).includes(needle)) continue;
    rows.push({
      kind: "environment",
      label: name,
      detail: "本项目定义",
      info: null,
      insert: "snippet",
      text: environmentInsertion(context.mode, name, "\n\t${0}"),
    });
  }
  rows.sort((a, b) => (lower(a.label).startsWith(needle) === lower(b.label).startsWith(needle) ? compareLabels(a.label, b.label) : lower(a.label).startsWith(needle) ? -1 : 1));
  return rows.slice(0, limit);
}

/**
 * `\begin{env` 的插入内容：`env}` + 环境自己的 body 片段 + `\end{env}`。
 * 光标已经停在 `<` 之后（`from` 指向 `{` 后），所以名字后面要补 `}`。
 */
export function environmentInsertion(mode: "begin" | "end", name: string, body: string): string {
  if (mode === "end") return `${name}}`;
  return `${name}}${body}\n\\end{${name}}`;
}

function suggestReferences(query: string, index: LatexProjectIndex | null, limit: number): LatexSuggestion[] {
  const labels: LatexLabelRef[] = index?.labels ?? [];
  const duplicate = new Set(index?.duplicateLabels ?? []);
  const needle = lower(query);
  const rows: LatexSuggestion[] = [];
  for (const label of labels) {
    if (needle !== "" && !lower(label.name).includes(needle)) continue;
    const note = duplicate.has(label.name) ? " · 同名 label 出现多次" : "";
    rows.push({
      kind: "reference",
      label: label.name,
      detail: `${label.file}:${label.line}${note}`,
      info: duplicate.has(label.name) ? `多处定义，引用编号可能指错：${label.file}:${label.line}` : `${label.file}:${label.line}`,
      insert: "plain",
      // 引用命令的参数多半是 `\ref{...}`：接受候选时补上 `}`（编辑器没有 closeBrackets）
      text: `${label.name}}`,
    });
  }
  rows.sort((a, b) => (lower(a.label).startsWith(needle) === lower(b.label).startsWith(needle) ? compareLabels(a.label, b.label) : lower(a.label).startsWith(needle) ? -1 : 1));
  return rows.slice(0, limit);
}

const GRAPHICS_EXTS = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"];
const TEX_EXTS = [".tex", ".ltx"];

function suggestPaths(
  query: string,
  mode: "tex" | "graphics" | "bib",
  index: LatexProjectIndex | null,
  limit: number,
): LatexSuggestion[] {
  const files = index?.files ?? [];
  const needle = lower(query);
  const rows: LatexSuggestion[] = [];
  for (const path of files) {
    const isDir = path.endsWith("/");
    if (!isDir) {
      const ext = extOf(path);
      if (mode === "tex" && !TEX_EXTS.includes(ext)) continue;
      if (mode === "graphics" && !GRAPHICS_EXTS.includes(ext)) continue;
      if (mode === "bib" && ext !== ".bib") continue;
    }
    if (needle !== "" && !lower(path).startsWith(needle)) continue;
    rows.push({
      kind: "path",
      label: path,
      detail: isDir ? "目录" : null,
      info: null,
      insert: "plain",
      // 目录补全到 `/`；文件补全到名字末尾（`}` 由用户自己打——有些命令后面还有参数）
      text: path,
    });
  }
  rows.sort((a, b) => compareLabels(a.label, b.label));
  return rows.slice(0, limit);
}

function suggestSnippets(query: string, limit: number): LatexSuggestion[] {
  const rows: LatexSuggestion[] = LATEX_SNIPPET_DATA.filter(
    (snippet) => snippet.prefix.startsWith(query) && (/^[A-Z]+$/.test(snippet.prefix) || /[^A-Za-z]/.test(snippet.prefix)),
  ).map((snippet) => ({
    kind: "snippet",
    label: snippet.prefix,
    detail: snippet.description,
    info: snippet.description,
    insert: "snippet",
    text: snippet.body,
  }));
  return rows.slice(0, limit);
}

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

function compareLabels(a: string, b: string): number {
  const left = lower(a);
  const right = lower(b);
  if (left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
