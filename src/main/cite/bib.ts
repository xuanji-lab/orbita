/**
 * BibTeX 解析器 —— 只要补全用得上的那部分：`key / type / title / author / year`。
 *
 * **不引依赖**：现成的 BibTeX 解析包（bibtex-parse-js / @retorquere/bibtex-parser
 * 一类）要么跟 citation-js 一整套拖进来，要么把「字段值的 TeX 转义」做到我们不需要
 * 的深度。补全需要的事实只有五个字段，而 BibTeX 的语法边界很清楚（`@type{key, f = v}`），
 * 自己写一百多行比审计一个依赖便宜。
 *
 * 语法里**真的会碰到的**都照顾到了（每一条都有测试）：
 * - 花括号嵌套（`title = {The {GPU} story}`）、跨行字段值；
 * - `#` 拼接（`title = "Part " # "two"`）、`@string` 定义当作宏展开；
 * - `@comment{…}` / `@comment 到行尾` / `@preamble{…}` 跳过，不产生条目；
 * - 括号包起来的条目（`@article(key, …)`）——老 BibTeX 允许；
 * - 坏条目（缺 key、缺 `=`、括号不闭合）**跳过并计数**，不让一个坏条目吃掉后面的
 *   整个文件。
 *
 * **不做的事**：不解释 TeX 宏（`\emph{}` / `{\"o}` 原样留着），不做交叉引用
 * （`crossref`）、不做字段值的语义校验。补全列表显示的是「人认得出的标题」，不是
 * 排版结果——真正排版在 LaTeX 里。
 */
import type { CiteEntry } from "../../shared/cite.ts";

/** 一份 .bib 的解析账 */
export interface ParsedBib {
  /** 按文件内出现顺序 */
  entries: CiteEntry[];
  /** 跳过的坏条目数 */
  bad: number;
}

/**
 * 解析出来的字段：补全要的五个（type 是条目头）+ `doi` / `eprint`。
 * **后两个是去重用的**：同一个 DOI 被检索面板选两次时，靠它们认出「库里已经有这篇」，
 * 不再追一份重复条目（评审 F6）。其余字段解析出来也丢掉——留着它们只会让一次扫描
 * 多出几 MB 的字符串，没人读。
 */
interface RawEntry {
  type: string;
  key: string;
  title: string | null;
  author: string | null;
  year: string | null;
  doi: string | null;
  eprint: string | null;
}

/** 一次条目扫描的结局：跳过 / 正常 / 坏；`next` 永远是下一次扫描的起点 */
type Scan =
  | { kind: "skip"; next: number }
  | { kind: "bad"; next: number }
  | { kind: "entry"; next: number; entry: RawEntry };

/** 字段名：字母开头，允许数字、`_`、`-`（BibTeX 实际出现的写法） */
const FIELD_NAME = /[A-Za-z][A-Za-z0-9_-]*/y;

/**
 * 解析一份 .bib 的全文。坏条目不会中断扫描：从失败处之后找下一个 `@` 继续，
 * 这一条计入 `bad`。
 */
export function parseBibtex(source: string): ParsedBib {
  const entries: CiteEntry[] = [];
  /** @string 定义的宏（键小写）：`#` 拼接时用得上，其它场合不参与 */
  const macros = new Map<string, string>();
  let bad = 0;
  let i = 0;

  while (i < source.length) {
    const at = source.indexOf("@", i);
    if (at < 0) break;
    const scan = scanEntry(source, at, macros);
    if (scan.kind === "bad") {
      bad += 1;
      // 从失败处之后继续找下一个 '@'：一个没闭合的条目不该让后面全部消失
      i = Math.max(scan.next, at + 1);
      continue;
    }
    if (scan.kind === "entry") {
      entries.push({
        key: scan.entry.key,
        type: scan.entry.type,
        title: scan.entry.title,
        author: scan.entry.author,
        year: scan.entry.year,
        doi: scan.entry.doi,
        eprint: scan.entry.eprint,
        // file 由扫描层（library.ts）填：解析器不知道自己在哪个文件里
        file: "",
      });
    }
    i = Math.max(scan.next, at + 1);
  }

  return { entries, bad };
}

/**
 * 从 `@` 开始扫一条。三种结局见 `Scan`。坏条目的 `next` 指向失败点，
 * 调用方据此继续找下一个 `@`。
 */
function scanEntry(source: string, at: number, macros: Map<string, string>): Scan {
  let i = skipSpace(source, at + 1);
  const type = readTypeWord(source, i);
  if (type === null) return { kind: "bad", next: at + 1 };
  i = skipSpace(source, i + type.length);

  const open = source[i];
  if (open !== "{" && open !== "(") {
    // `@comment` 允许不戴括号：BibTeX 把这一行的剩余部分当注释
    if (type === "comment") return { kind: "skip", next: endOfLine(source, i) };
    return { kind: "bad", next: at + 1 };
  }
  const close = open === "{" ? "}" : ")";
  const bodyStart = i + 1;

  if (type === "comment" || type === "preamble") {
    const end = skipBalanced(source, i, open, close);
    return end < 0 ? { kind: "bad", next: bodyStart } : { kind: "skip", next: end };
  }
  if (type === "string") {
    const end = skipBalanced(source, i, open, close);
    if (end < 0) return { kind: "bad", next: bodyStart };
    // @string 的内容当作一条「只有字段」的条目解析：`@string{acm = "ACM"}`
    readMacroDefinition(source.slice(bodyStart, end - 1), macros);
    return { kind: "skip", next: end };
  }

  // 普通条目：key 到 `,` 或收尾括号为止。key 里可以有冒号、斜杠、点（`doe:2020/a`）
  i = skipSpace(source, bodyStart);
  const keyStart = i;
  while (i < source.length && source[i] !== "," && source[i] !== close) {
    const ch = source[i];
    if (ch === "{" || ch === "}" || ch === "=" || ch === "\n" || ch === "\r") {
      return { kind: "bad", next: i };
    }
    i += 1;
  }
  const key = source.slice(keyStart, i).trim();
  if (key === "") return { kind: "bad", next: i };

  const fields = new Map<string, string>();
  if (source[i] === close) {
    // `@misc{key}`：没有字段也算一条（有人用它占位），但没有可显示的内容
    return {
      kind: "entry",
      next: i + 1,
      entry: { type, key, title: null, author: null, year: null, doi: null, eprint: null },
    };
  }
  i += 1; // 吃掉 key 后的逗号

  while (true) {
    i = skipSpaceAndCommas(source, i);
    if (i >= source.length) return { kind: "bad", next: source.length };
    if (source[i] === close) return { kind: "entry", next: i + 1, entry: toRaw(type, key, fields) };

    FIELD_NAME.lastIndex = i;
    const name = FIELD_NAME.exec(source)?.[0] ?? null;
    // 停在这里而不是 +1：下一个 `@` 可能就在这一格（一条坏条目紧接着下一条）
    if (name === null) return { kind: "bad", next: i };
    i = skipSpace(source, i + name.length);
    if (source[i] !== "=") return { kind: "bad", next: i };
    i = skipSpace(source, i + 1);

    const value = readValue(source, i, close, macros);
    if (value === null) return { kind: "bad", next: i };
    i = value.next;
    const field = name.toLowerCase();
    // 同一条目里重复字段：先出现的算（BibTeX 自己的行为也是「第一条胜」）
    if (!fields.has(field)) fields.set(field, value.text);
  }
}

/** 字段值：若干段用 `#` 拼起来（花括号串 / 引号串 / 数字 / 宏名） */
function readValue(
  source: string,
  start: number,
  close: string,
  macros: Map<string, string>,
): { text: string; next: number } | null {
  const parts: string[] = [];
  let i = start;
  while (true) {
    i = skipSpace(source, i);
    const ch = source[i];
    if (ch === undefined) return null;
    if (ch === "{") {
      const end = skipBalanced(source, i, "{", "}");
      if (end < 0) return null;
      parts.push(source.slice(i + 1, end - 1));
      i = end;
    } else if (ch === '"') {
      const end = skipQuoted(source, i);
      if (end < 0) return null;
      parts.push(source.slice(i + 1, end - 1));
      i = end;
    } else {
      const word = readBareToken(source, i, close);
      if (word === "") return null;
      // 纯数字是字面值；其它裸词是宏名（@string 定义的），没定义就当空串
      parts.push(/^\d+$/.test(word) ? word : (macros.get(word.toLowerCase()) ?? ""));
      i += word.length;
    }
    i = skipSpace(source, i);
    if (source[i] !== "#") break;
    i += 1;
  }
  return { text: cleanText(parts.join("")), next: i };
}

/**
 * 多文件合并：同 key **先出现者为准**（传入顺序就是文件顺序），来源文件名写进
 * 条目的 `file`；结果按 key 排序（大小写不敏感，同 key 不同大小写时再按原样比一次，
 * 保证排序稳定、与平台 locale 无关）。
 *
 * 去重放在这里而不是解析器里：解析器不知道「哪份文件先」——那是调用方读盘顺序的事实。
 */
export function mergeBibEntries(
  files: readonly { path: string; entries: readonly CiteEntry[] }[],
): CiteEntry[] {
  const byKey = new Map<string, CiteEntry>();
  for (const file of files) {
    for (const entry of file.entries) {
      // 大小写不同的同一个 key 在 BibTeX 里是不同的 key（它区分大小写），但引用时
      // 几乎总是同一个意思；按原文比较，只把完全相同的当重复
      if (byKey.has(entry.key)) continue;
      byKey.set(entry.key, { ...entry, file: file.path });
    }
  }
  return [...byKey.values()].sort(compareKeys);
}

/** key 排序：先比小写形式，相同再比原样（`A` / `a` 两个 key 不会因大小写抖动顺序） */
function compareKeys(a: CiteEntry, b: CiteEntry): number {
  const lower = a.key.toLowerCase().localeCompare(b.key.toLowerCase(), "en");
  if (lower !== 0) return lower;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * 显示用的纯文本：去掉花括号（它们是大小写保护标记）、`~` 换成空格、空白折叠。
 * TeX 命令原样留着——补全列表是「认得出是哪一篇」，不是排版结果。
 */
export function cleanText(raw: string): string {
  return raw.replace(/[{}]/g, "").replace(/~/g, " ").replace(/\s+/g, " ").trim();
}

function toRaw(type: string, key: string, fields: Map<string, string>): RawEntry {
  const year = fields.get("year") ?? firstYear(fields.get("date"));
  return {
    type,
    key,
    title: emptyToNull(fields.get("title")),
    author: emptyToNull(fields.get("author")),
    year: emptyToNull(year),
    doi: emptyToNull(fields.get("doi")),
    eprint: emptyToNull(fields.get("eprint")),
  };
}

/** biblatex 的 `date = {2020-05-01}`：没有 year 时取前四位数字 */
function firstYear(date: string | undefined): string | undefined {
  if (date === undefined) return undefined;
  return /\d{4}/.exec(date)?.[0];
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** `@string{name = "value"}` 的正文 → 宏表（同一条里多个定义也算，BibTeX 允许） */
function readMacroDefinition(body: string, macros: Map<string, string>): void {
  const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([\s\S]*)$/.exec(body);
  if (match === null) return;
  const name = match[1]?.toLowerCase();
  if (name === undefined) return;
  const value = readValue(match[2] ?? "", 0, "\u0000", macros);
  if (value !== null) macros.set(name, value.text);
}

function readTypeWord(source: string, start: number): string | null {
  const match = /[A-Za-z]+/y;
  match.lastIndex = start;
  const word = match.exec(source)?.[0];
  return word === undefined ? null : word.toLowerCase();
}

/**
 * 裸词（宏名 / 数字）：到空白、`#`、`,`、括号或 `@` 为止。
 * 遇到 `@` 就停是关键——`author = 
@book{next,…}` 这种漏了值的坏字段，
 * 不在这里停下会把下一条目整个吃进当前条目。
 */
function readBareToken(source: string, start: number, close: string): string {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined || /\s/.test(ch) || ch === "#" || ch === "," || ch === close) break;
    if (ch === "{" || ch === "}" || ch === "(" || ch === ")" || ch === "@") break;
    i += 1;
  }
  return source.slice(start, i);
}

/**
 * 从开括号扫到配对的收括号，返回**收括号之后**的下标；不闭合返回 -1。
 * 花括号与圆括号分开计数（`@article(…{…}…)` 这种混用不会互相干扰）。
 * `\{` / `\}` 不算括号（TeX 自己的转义）。
 */
function skipBalanced(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * 引号串：到同一层的 `"` 为止。花括号**成对**计数——花括号里的 `"` 不结束字符串
 * （BibTeX 允许 `title = "The {"} sign"` 这类写法要靠它）。
 */
function skipQuoted(source: string, start: number): number {
  let depth = 0;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === '"' && depth === 0) return i + 1;
    i += 1;
  }
  return -1;
}

function skipSpace(source: string, start: number): number {
  let i = start;
  while (i < source.length && /\s/.test(source[i] ?? "")) i += 1;
  return i;
}

function skipSpaceAndCommas(source: string, start: number): number {
  let i = start;
  while (i < source.length && (/[\s,]/.test(source[i] ?? ""))) i += 1;
  return i;
}

function endOfLine(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline < 0 ? source.length : newline + 1;
}
