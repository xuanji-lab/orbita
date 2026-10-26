/**
 * 候选文献 → 一条 BibTeX 条目 + 一个引用 key。
 *
 * 排版在**主进程**做，renderer 只拿「写好了，key 是 X」：`\cite{}` 里插的是 key，
 * 而 key 的去重要看盘上那份 .bib 现在有什么——那是主进程刚才读过的事实，不是
 * renderer 手里的旧快照。
 *
 * 三件容易被做错的事，都在这里做对：
 * 1. **转义**：`&` `%` `_` `#` `$` `^` `~` 与落单的花括号在 BibTeX / LaTeX 里都有
 *    语法意义。标题里一个没转义的
 *    `&` 会让整份 .bib 编译失败，而且报错指向别的条目（`%` 更糟：它注释掉这一行
 *    剩下的部分）。已经转义过的（`\%`）不重复加反斜杠。
 * 2. **HTML 实体与标签**：Crossref 的标题真的带 `<i>`、`&amp;`、`<sub>`。逐字塞进
 *    .bib 会在排版结果里出现字面量 `&amp;` 与尖括号。
 * 3. **key 去重**：`vaswani2017attention` 已经存在时再加 a / b 后缀。同一篇文献在
 *    两个 .bib 里各有一份是常态，静默重名会让 `\cite` 指向不确定的那一条。
 */
import type { CiteAuthor, CiteCandidate } from "../../shared/cite.ts";
import { cleanTitle } from "./search.ts";

/**
 * key 里跳过这些词再取第一个「实词」：`The Attention Economy` 的 key 该是
 * `…attention`，不是 `…the`。冠词 / 介词 / be 动词，纯英文的常见开头。
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "on",
  "of",
  "in",
  "for",
  "and",
  "to",
  "with",
  "at",
  "by",
  "from",
  "into",
  "via",
  "using",
  "toward",
  "towards",
  "is",
  "are",
  "was",
  "were",
  "be",
  "as",
  "its",
  "their",
  "this",
  "that",
  "these",
  "those",
  "how",
  "what",
  "why",
  "when",
  "we",
]);

/**
 * 字段值里的特殊字符：前有反斜杠的已经是转义形式，不再加一层。
 *
 * `^` 与 `~` 也得转（评审 F8）：`O(n^2)` 里的 `^` 在 LaTeX 里是上标，原样进 .bib
 * 会让整篇编译报 Missing $；`~` 是非断行空格，在标题里会把词粘在一起。散花括号在
 * `balanceBraces` 里单独处理（那里要看配对，不能逐个替换）。
 */
const SPECIAL = /(?<!\\)([&%_#$])/g;

/** `^` / `~` 没有「字面量本身」的写法，必须换成命令 */
export function escapeBib(raw: string): string {
  return balanceBraces(cleanTitle(raw))
    .replace(SPECIAL, "\\$1")
    .replace(/(?<!\\)\^/g, "\\textasciicircum{}")
    .replace(/(?<!\\)~/g, "\\textasciitilde{}");
}

/**
 * 落单的 `}` / `{` 也要转义（`a}b` 会让字段提前结束，`{GPU` 会让后面全变成大小写
 * 保护串）。**配对的保留**：`{GPU}` / `{\"o}` 是有意义的大小写保护与重音写法。
 */
function balanceBraces(text: string): string {
  const out: string[] = [];
  /** 还没关上的 `{` 在 out 里的位置：最后补反斜杠时就按这些下标改 */
  const unclosed: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      // `\{` / `\}` 是转义写法：原样带走两个字符
      out.push(ch, text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === "{") {
      unclosed.push(out.length);
      out.push(ch);
      continue;
    }
    if (ch === "}") {
      if (unclosed.length === 0) {
        out.push("\\}");
        continue;
      }
      unclosed.pop();
      out.push(ch);
      continue;
    }
    out.push(ch ?? "");
  }
  // 没关上的 `{` 逐个转义（从后往前改，前面元素的下标不漂）
  for (const index of unclosed.reverse()) out[index] = "\\{";
  return out.join("");
}

/** `Family, Given and …`：BibTeX 的 `and` 分隔、姓在前 */
export function bibAuthors(authors: readonly CiteAuthor[]): string {
  return authors.map(bibAuthor).join(" and ");
}

/**
 * 一位作者 → `Family, Given`。**直接拼给定的 given / family**，不再从显示串里
 * 猜姓（评审 F7：`García Márquez, Gabriel` 曾经被拍平成 `Márquez, Gabriel García`）。
 * 只有一边时就用那一边（机构作者）。
 */
function bibAuthor(author: CiteAuthor): string {
  const family = escapeBib(author.family);
  const given = escapeBib(author.given);
  if (family === "") return given;
  if (given === "") return family;
  return `${family}, ${given}`;
}

/**
 * key 的前半段：第一作者姓 + 年份 + 标题第一个实词，全小写、只留字母数字。
 * 重音去掉（`García` → `garcia`）：BibTeX key 里放非 ASCII 不是不能编，但换个
 * 引擎 / 换个编辑器就会出现两种写法，同一条文献被引用两次。
 */
export function bibKeyBase(candidate: CiteCandidate): string {
  const first = candidate.authors[0];
  // 姓优先用 family（Crossref 的结构化字段）；arXiv 只给整名，那里把最后一个词当姓
  const surname = asciiWord(first === undefined ? "" : first.family !== "" ? first.family : lastWord(first.given));
  const year = /\d{4}/.exec(candidate.year ?? "")?.[0] ?? "nd";
  const word = titleWord(candidate.title);
  const base = `${surname === "" ? "anon" : surname}${year}${word}`;
  return base === "" ? "ref" : base;
}

/** 只有整名可用时的姓：空白分开的最后一个词 */
function lastWord(name: string): string {
  const parts = name.split(/\s+/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "";
}

/** 在已有 key 之上找一个不重名的：base → basea → baseb … */
export function uniqueBibKey(base: string, existingKeys: Iterable<string>): string {
  const taken = new Set<string>();
  for (const key of existingKeys) taken.add(key.toLowerCase());
  if (!taken.has(base)) return base;
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    if (!taken.has(`${base}${letter}`)) return `${base}${letter}`;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function titleWord(title: string): string {
  const words = cleanTitle(title).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const significant = words.find((word) => !STOPWORDS.has(word.toLowerCase()) && word.length > 1);
  return asciiWord(significant ?? words[0] ?? "");
}

/** 去掉重音、只留 ASCII 字母数字 */
function asciiWord(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * 一条候选 → 完整的 BibTeX 条目文本（不含前后空行）。
 * 字段顺序固定：title / author / year 在最前，读者（和 diff）最先看到这三样。
 */
export function formatBibEntry(candidate: CiteCandidate, key: string): string {
  const fields: { name: string; value: string }[] = [];
  const push = (name: string, value: string | null): void => {
    if (value !== null && value !== "") fields.push({ name, value });
  };

  push("title", escapeBib(candidate.title));
  if (candidate.authors.length > 0) push("author", bibAuthors(candidate.authors));
  push("year", candidate.year);
  if (candidate.type === "inproceedings") {
    push("booktitle", candidate.venue === null ? null : escapeBib(candidate.venue));
  } else if (candidate.type === "article") {
    push("journal", candidate.venue === null ? null : escapeBib(candidate.venue));
  }
  push("volume", candidate.volume === null ? null : escapeBib(candidate.volume));
  push("pages", pagesField(candidate.pages));
  if (candidate.type === "misc" && candidate.arxivId !== null) {
    push("eprint", candidate.arxivId);
    push("archivePrefix", "arXiv");
    push("primaryClass", candidate.primaryClass === null ? null : escapeBib(candidate.primaryClass));
  }
  push("doi", candidate.doi === null ? null : escapeBib(candidate.doi));

  const body = fields.map((field) => `  ${field.name} = {${field.value}},`).join("\n");
  return `@${candidate.type}{${key},\n${body}\n}`;
}

/** `5998-6008` → `5998--6008`（BibTeX 的页码区间是两个连字符）；其它写法原样 */
function pagesField(pages: string | null): string | null {
  if (pages === null) return null;
  const cleaned = pages.replace(/\s+/g, "");
  if (/^\d+[-–]\d+$/.test(cleaned)) return cleaned.replace(/[-–]/, "--");
  return escapeBib(pages);
}

/**
 * 追加到一份 .bib 的末尾：保留原有的行尾风格（Windows 上的 .bib 常是 CRLF），
 * 条目之间空一行。空文件 / 只有空白时不留前导空行。
 */
export function appendBibEntry(source: string, entry: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const trimmed = source.replace(/\s+$/, "");
  const body = entry.replace(/\n/g, eol);
  return trimmed === "" ? `${body}${eol}` : `${trimmed}${eol}${eol}${body}${eol}`;
}
