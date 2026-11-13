/**
 * 引用补全的**纯逻辑**（`node --test` 覆盖）：光标处是不是 `\cite{…}`、已经输入了什么、
 * 候选怎么过滤与怎么显示。CodeMirror 的接线在 latex-completion.ts，那一层只负责把这里
 * 的结论换成 `Completion` 对象。
 *
 * 支持的命令是**显式名单**，不是 `\cite.*` 正则：`\citeindextrue`、`\defcitealias`
 * 这类同样以「cite」开头的命令不该弹文献列表，误报一次就会往导言区插一个 key。
 * 名单覆盖 natbib（citep / citet / citealp / citealt / citeauthor / citeyear，连正式
 * 的大写写法 Cite / CiteA / CiteN 与复数 cites / parencites / textcites）、biblatex
 * （parencite / textcite / autocite / footcite / footcitetext）与 AASTeX 的
 * shortcite / supercite。
 *
 * **已知取舍**：`\begin{comment}` 环境里与 `\verb` 里面的 `\cite` 仍会弹候选——
 * 判断它们要真的理解环境栈（`\begin` / `\end` 配对）与 `\verb` 的分隔符扫描，
 * 而代价只是「在一个不会编译的地方弹了一个列表」。`%` 行注释是唯一会骗到人的
 * 情形（一整行都不编译），所以只认它。
 */
import { CITE_MAX_SUGGESTIONS, type CiteEntry } from "../../../../shared/cite.ts";

/** 会接 `{key, …}` 的命令名（大小写两种写法都是 natbib 的正式写法） */
export const CITE_COMMANDS = [
  "cite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "citenum",
  "citetitle",
  "citeurl",
  "Citep",
  "Citet",
  "Citealp",
  "Citealt",
  "Citeauthor",
  "parencite",
  "Parencite",
  "textcite",
  "Textcite",
  "autocite",
  "Autocite",
  "footcite",
  "footcitetext",
  "smartcite",
  "fullcite",
  "nocite",
  // natbib 的正式大写写法（`\Cite` 是 citet 的别名，`\CiteA` / `\CiteN` 是
  // textual / numeric 两种模式），以及复数形式（一次引多篇）
  "Cite",
  "cites",
  "parencites",
  "textcites",
  "citeA",
  "citeN",
  // AASTeX 的短引用 / 上标引用
  "shortcite",
  "supercite",
] as const;

/**
 * 命令 + 至多两个可选参数（`\citep[see][p.~3]{`）+ `{` + 光标前的内容。
 * 命令与 `{` 之间不许换行（`\cite` 后换行是合法 TeX，但那不是「正在输入 key」的现场）；
 * **花括号内允许换行**：长引用常写成一行一个 key，换了行还该继续给候选。
 */
const CITE_ARG = new RegExp(
  `\\\\(?:${CITE_COMMANDS.join("|")})(?![A-Za-z])\\*?[ \t]*(?:\\[[^\\]\\n]*\\][ \t]*){0,2}\\{([^{}]*)$`,
);

/** 补全的替换区间与已输入的查询词 */
export interface CiteArgument {
  /** `from` 在传入文本里的下标：本次候选替换从这里开始（`{` 之后或最后一个逗号之后） */
  from: number;
  /** 已输入的 key 片段（不含前导空白）；空串表示 `\cite{` 刚打完 */
  query: string;
}

/**
 * 文本**末尾就是光标**时的 `\cite{…}` 现场。不在现场（没有命令、光标在注释里、
 * 已经写了 `}`）回 null。
 *
 * 注释判定只看同一行：`% \cite{` 不该弹列表，而 `\% \cite{` 里那个百分号是字面量。
 */
export function citeArgumentBefore(text: string): CiteArgument | null {
  const match = CITE_ARG.exec(text);
  if (match === null) return null;
  const start = match.index;
  if (start === undefined) return null;
  const lineStart = text.lastIndexOf("\n", start) + 1;
  if (inComment(text.slice(lineStart, start))) return null;

  const args = match[1] ?? "";
  // `\cite{a,b` 的候选从逗号之后算：前面那些 key 已经定了
  const comma = args.lastIndexOf(",");
  const typed = comma < 0 ? args : args.slice(comma + 1);
  const lead = typed.length - typed.trimStart().length;
  const from = start + match[0].length - typed.length + lead;
  return { from, query: typed.slice(lead).trimEnd() };
}

/** 这一行里在 `position` 之前有没有未转义的 `%` */
function inComment(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "%") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

/**
 * 候选：key / 标题 / 作者里任意一处包含查询词就算命中（大小写不敏感），
 * **按 key 排序**（主进程给的就是这个顺序，这里再排一次是为了排序规则不依赖序列化）。
 * 上限 `CITE_MAX_SUGGESTIONS`：几百条文献的弹层滚不动，多打几个字就窄了。
 */
export function suggestCites(
  entries: readonly CiteEntry[],
  query: string,
  limit: number = CITE_MAX_SUGGESTIONS,
): CiteEntry[] {
  const needle = query.trim().toLowerCase();
  const matched = needle === ""
    ? [...entries]
    : entries.filter((entry) => matches(entry, needle));
  matched.sort((a, b) => compareKeys(a.key, b.key));
  return matched.slice(0, limit);
}

function matches(entry: CiteEntry, needle: string): boolean {
  return (
    entry.key.toLowerCase().includes(needle) ||
    (entry.title?.toLowerCase().includes(needle) ?? false) ||
    (entry.author?.toLowerCase().includes(needle) ?? false)
  );
}

function compareKeys(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  if (lower !== 0) return lower;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 候选行右侧的说明：`标题 (年)`。没有标题时退成条目类型（`misc (2020)`）——
 * 一行只有 key 的候选在多文件合并时看不出是哪一份。
 */
export function citeDetail(entry: CiteEntry): string {
  const year = entry.year === null ? "" : ` (${entry.year})`;
  const head = entry.title ?? entry.type;
  return `${head}${year}`;
}

/**
 * 接受候选时插入的文本：key 后面**补上 `}`**，除非那里已经有一个（用户先打了右括号
 * 再回头选候选，就不能补出 `}}`）。编辑器没有 closeBrackets，不补的话每选一次都要
 * 自己再敲一个右括号。
 */
export function citeInsertion(key: string, nextChar: string | undefined): string {
  return nextChar === "}" ? key : `${key}}`;
}

/**
 * 候选行的补充说明（选中时才显示）：**完整标题** + 作者 + 来源 .bib。
 *
 * 标题在候选行里只占一行，右栏又只有三百来像素宽，长标题会被省略号截断（评审 F2）；
 * 这里给全文，截断就不再是信息丢失。来源文件是「同 key 出现在两份文件里」时唯一
 * 的线索——去重规则是「先出现者为准」，用户得能看见它选了哪一份。
 */
export function citeInfo(entry: CiteEntry): string {
  return [entry.title, entry.author, entry.file]
    .filter((part): part is string => part !== null && part !== "")
    .join("\n");
}
