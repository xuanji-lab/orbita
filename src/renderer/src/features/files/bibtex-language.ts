/**
 * BibTeX 高亮（`.bib` 标签）—— StreamLanguage + 一个按行扫描的窄词法器。
 *
 * 为什么自写而不是等第三方包：`.bib` 的语法只有「`@类型{key, 字段 = 值, …}`」一层，
 * 自写几十行就够；引一个维护状态不明的 grammar 包不划算（与 latex-editor.ts 选
 * legacy-modes/stex 是同一条理由）。claude-prism 也是自写的（326 行，它要处理更多
 * 边界；这里只需要着色，不做解析）。
 *
 * 不做的事：不校验字段、不折叠、不补全字段名——`.bib` 的可编辑性靠编辑器的通用管线
 * （自动保存 / 冲突 / 协作只读），那一条不需要知道 BibTeX 语法。
 *
 * Token 名字走 CodeMirror 的标准表：`tagName`（@article）、`propertyName`（字段名）、
 * `string` / `atom`（值）、`number`、`comment`（`%` 到行尾）、`bracket`、`operator`。
 * 颜色由 latex-editor.ts 的同一份 HighlightStyle 决定，`.bib` 没有第二套主题。
 */
import { StreamLanguage, type StreamParser } from "@codemirror/language";

/**
 * 词法器只用到 StringStream 的这几个方法。单列成接口是为了能用假流写测试
 * （`node --test` 里没有 CodeMirror 的编辑器实例）。
 */
export interface BibTokenStream {
  eatSpace: () => boolean;
  peek: () => string | undefined;
  next: () => string | void;
  skipToEnd: () => void;
  /** CodeMirror 的 match 返回 `boolean | RegExpMatchArray | null`：真假判断即可 */
  match: (pattern: RegExp, consume?: boolean) => boolean | RegExpMatchArray | null;
}

/** 扫一个 token。返回 null = 这一格只是空白，不需要着色 */
export function bibTexToken(stream: BibTokenStream): string | null {
  if (stream.eatSpace()) return null;

  // `%` 到行尾：BibTeX 官方注释是条目外的自由文本，但 `%` 是写论文的人最常用的写法
  if (stream.peek() === "%") {
    stream.skipToEnd();
    return "comment";
  }

  // 条目类型：@article / @book / @string / @comment
  if (stream.peek() === "@") {
    stream.next();
    return stream.match(/^[A-Za-z]+/) ? "tagName" : "atom";
  }

  const ch = stream.next();
  // CodeMirror 的 StringStream.next() 声明返回 `string | void`：用 typeof 收窄，
  // 假流（测试）返回 `string | undefined` 也走同一条判断
  if (typeof ch !== "string") return null;

  if (ch === "{" || ch === "}" || ch === "(" || ch === ")") return "bracket";
  if (ch === "=" || ch === "," || ch === "#") return "operator";

  // 引号字符串（允许内部的花括号，BibTeX 里常见 `"A {B} C"`）
  if (ch === '"') {
    stream.match(/^(?:[^"\\]|\\.)*"?/);
    return "string";
  }

  if (/\d/.test(ch)) {
    stream.match(/^\d*/);
    return "number";
  }

  // 词：字段名后面一定跟 `=`；否则是值 / 条目 key / @string 宏名
  stream.match(/^[^\s{}(),="#%]+/);
  return stream.match(/^\s*=/, false) ? "propertyName" : "atom";
}

const bibtexParser: StreamParser<Record<string, never>> = {
  name: "bibtex",
  startState: () => ({}),
  token: (stream) => bibTexToken(stream),
};

export const bibtexLanguage = StreamLanguage.define(bibtexParser);
