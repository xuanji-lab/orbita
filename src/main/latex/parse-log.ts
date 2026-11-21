/**
 * .log 解析 —— 编译结果里所有「哪里错了、第几行、几页」都从这里来。
 *
 * **读 .log，不读 stdout**：latexmk 的 stdout 是它自己的进度叙述（一轮轮
 * `Run number 1 of rule 'pdflatex'`），格式随版本与 -silent 变；TeX 引擎写的
 * .log 才是错误原文——`-file-line-error` 的 `file:line:` 前缀、缺包、缺字体、
 * Overfull hbox、`Output written on … (N pages)` 全在那一份里。而且超时被杀时
 * .log 至少已经写到了中断处，stdout 往往连缓冲区都没吐出来。
 *
 * 纯函数、无 IO：run.ts 负责按 outDir 拼 .log 路径并读出来，这里只认文本。
 */
import {
  LATEX_MAX_ERRORS,
  LATEX_MAX_LAYOUT,
  LATEX_MAX_WARNINGS,
  LATEX_RAW_ERRORS,
  miktexPendingOf,
  type LatexDiagnosticCode,
  type LatexIssue,
  type LatexIssueKind,
} from "../../shared/latex.ts";

/** 单条 message 的字符上限（折行拼回后仍可能很长）；超了以 … 结尾 */
const MAX_MESSAGE_CHARS = 240;

/** raw 块的字符上限（规格：≤ 4 行 / ≤ 400 字符） */
const MAX_RAW_CHARS = 400;

/** 续行最多往下接几行（fontspec 的字体散文可以接 6 行以上；再多就不是同一个错块了） */
const MAX_CONTINUATION_LINES = 8;

/**
 * TeX 的 `max_print_line` 默认 79：**写满这个宽度**的行被 TeX 硬折断，下一行是
 * 没有 `(pkg)` 前缀的纯续行（`…using draft s` / `etting.`）。只在上一行确实写满时
 * 才拼（否则会把下一条独立消息当续行吞掉）。
 */
const MAX_PRINT_LINE = 79;

export interface ParsedLatexLog {
  /** 全部诊断，**日志顺序**（= 因果顺序）。真源 */
  diagnostics: LatexIssue[];
  /** 每种 kind 因上限没列出的条数（0 = 没截） */
  omitted: { errors: number; warnings: number; layout: number };
  /** 镜像：diagnostics 里 kind === "error" 的那些 */
  errors: LatexIssue[];
  /** 镜像：diagnostics 里的非 error（含 layout） */
  warnings: LatexIssue[];
  /** `Output written on …` 的**每一条**（多 target / 多次写出时不会互相覆盖） */
  outputs: LoggedOutputItem[];
  /** 最后一条的页数（= outputs.at(-1).pages；旧消费者保留） */
  pages: number | null;
  /**
   * 最后一条 `Output written on <path>` 里的 <path>（镜像，与 outputs 末项同源）。
   * **产物不一定在 -outdir**：自定义 recipe 可以不传 -outdir，PDF / log 就落在主文件旁边。
   */
  output: string | null;
}

/** 日志里的一条产物（`Output written on build/main.pdf (3 pages, 12345 bytes).`） */
export interface LoggedOutputItem {
  /** 日志里的原始写法（"build/main.pdf" / "main.pdf"） */
  path: string;
  pages: number;
  bytes: number | null;
}

/** 夹带文件名的行：`./main.tex:5: …`、`C:\paper\main.tex:5: …`（贪婪匹配取最后一个 :数字: 对） */
const FILE_LINE_PREFIX = /^(.+):(\d+):\s*(.*)$/;

/** 能进括号栈的扩展名。TeX 的括号嵌套对任意文件都成立，但只认这些才不会被正文里的括号带偏 */
const TRACKED_FILE = /^([^\s(){}]+\.(?:tex|sty|cls|def|cfg|clo|fd|aux|bbl|toc|out|ind))/i;

/**
 * TeX 的**续行**：`(fontspec)                The font …`、`(pdftex.def) …`。
 * 消息本身在 79 列处被折断，第一行往往只有 `Package fontspec Error:`，真正的
 * 句子从下一行开始——只取单行的旧解析器因此给出空消息（本机真跑复现）。
 *
 * 名字必须紧跟右括号（`(see the transcript file for …)` 这种正文括号不匹配），
 * 且只收字母开头、字母数字与 `._+-` 组成的包 / 类 / 引擎名。
 */
const CONTINUATION = /^\(([A-Za-z][A-Za-z0-9._+-]*)\)\s?(.*)$/;

/** 括号栈：TeX 在 .log 里用 `(./sections/intro.tex` 表示「进入了这个文件」、
 * `)` 表示离开。**尽力而为**——TeX 自己也无法保证括号完全平衡（文件名里带括号、
 * 日志被截断都会破坏它），所以它只用来给「没有文件前缀的错」补归属：栈里
 * 找不到文件就落 null，不猜。
 *
 * 非文件名的 `(` **也压栈（记为 null）**：`Overfull \hbox (5.5pt too wide)` 这种
 * 正文行里的括号必须成对消耗，否则它的 `)` 会把真正的文件弹掉——真实日志里
 * 每一条 Overfull 都带着这么一对括号。
 */
function trackFileStack(line: string, stack: (string | null)[]): void {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "(") {
      const match = TRACKED_FILE.exec(line.slice(index + 1));
      if (match !== null) {
        stack.push(normalizeFile(match[1] ?? ""));
        index += (match[0] ?? "").length;
      } else {
        stack.push(null);
      }
    } else if (char === ")" && stack.length > 0) {
      stack.pop();
    }
  }
}

/** 栈里最近的一个文件（顶层可能是正文括号的 null） */
function currentFile(stack: readonly (string | null)[]): string | null {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (entry !== null && entry !== undefined) return entry;
  }
  return null;
}

function normalizeFile(value: string): string {
  return value.replace(/^\.\//, "").replace(/^\.\\/, "").trim();
}

/** 一行日志（已剥掉 file:line 前缀）的分类；null = 不关心的行 */
function classify(message: string, prefixed: boolean): LatexIssueKind | "info" | null {
  if (message.startsWith("!")) return "error";
  if (/^(?:Overfull|Underfull) \\[hv]box/.test(message)) return "layout";
  // MiKTeX 在等用户确认安装 / 造字：不是 TeX 的错，但也不能丢——界面要把它
  // 单独说成「引擎在等你确认」，而不是让用户对着卡住的编译条猜
  if (miktexPendingOf(message)) return "warning";
  // 告警先于「带前缀即错」的兑底：`./main.tex:12: LaTeX Warning: …` 也是带前缀的
  if (/^(?:LaTeX|LaTeX Font|Package\s+\S+|Class\s+\S+|pdfTeX|XeTeX|LuaTeX)\s+(?:Warning|warning):/.test(message)) {
    return "warning";
  }
  if (/^Missing character:/.test(message)) return "warning";
  if (/^Font\b.*(?:not found|not loadable)/.test(message)) return "warning";
  if (/^(?:LaTeX|Package\s+\S+|Class\s+\S+|pdfTeX|XeTeX|LuaTeX)\s+Error:/.test(message)) return "error";
  // `==> Fatal error occurred`：latexmk 自己的收尾行，前面带箭头
  if (/^(?:==>\s*)?(?:Emergency stop|Fatal error)/.test(message)) return "error";
  if (/^Output written on /.test(message)) return "info";
  /*
   * `-file-line-error` 形态。TeX 只在**错误**行前加 `file:line:` 前缀，而剥掉前缀后
   * 剩下的往往是裸消息：`Missing $ inserted.` / `Undefined control sequence.` /
   * `Runaway argument?` —— 它们既不以 `!` 开头，也不带 "LaTeX Error:"。
   * 默认 argv 常开 -file-line-error，所以**带前缀就是错的强信号**；不认这一条的话
   * 最常见的错误形态会整条丢掉（评审 B1）。告警/版式/信息行在上面已经先认领了。
   */
  if (prefixed) return "error";
  return null;
}

/**
 * 诊断的**类别**。解析器本来就用正则认这些形态，以前把结论丢掉了，模型只能靠
 * message 猜。顺序有意义：缺包（`.sty`/`.cls`）先于泛化的「文件没找到」。
 */
export function diagnosticCodeOf(message: string, kind: LatexIssueKind): LatexDiagnosticCode {
  if (kind === "layout") return "layout";
  if (/\bCitation\b.*\bundefined\b/.test(message)) return "citation-undefined";
  if (/\bReference\b.*\bundefined\b/.test(message)) return "reference-undefined";
  if (/\bUndefined control sequence\b/.test(message)) return "undefined-control-sequence";
  const missingFile = /\bFile [`']([^`']+)[`'] not found/.exec(message);
  if (missingFile !== null) {
    return /\.(?:sty|cls|def|clo)$/i.test(missingFile[1] ?? "") ? "missing-package" : "missing-file";
  }
  if (/(?:Emergency stop|Fatal error)/.test(message)) return "emergency-stop";
  if (/fontspec|xeCJK|xunicode|Missing character|Font\b.*?(?:not found|not loadable)/i.test(message)) {
    return "font-missing";
  }
  if (/Missing bbl file|I couldn't open|runscript|Latexmk:|latexmk/i.test(message)) return "tool-failure";
  return "other";
}

/** `l.42 \foo` 那一行的行号（TeX 错的位置紧跟在 ! 行之后） */
function missingLineNumber(lines: readonly string[], from: number): number | null {
  for (let index = from + 1; index < Math.min(from + 4, lines.length); index += 1) {
    const match = /^l\.(\d+)/.exec((lines[index] ?? "").trim());
    if (match !== null) return Number(match[1]);
  }
  return null;
}

/**
 * 缺文件类错的近似行号。`! LaTeX Error: File `x.sty' not found.` 在 TeX Live 的日志里
 * **没有 `l.N` 行**（TeX 停下来问文件名，然后在下一条输入行 Emergency stop），
 * 于是同一个错只有消息没有行号。这里在同一文件的后续 12 行里找一个定位点：
 * 先认 `l.N`，再认同文件的 `file:N:`（Emergency stop 就是这样写成
 * `./main.tex:3: Emergency stop.`）。找不到就老实落 null——行号是辅助，
 * 给个编造的数字比不给更坏。
 */
function nearbyLineNumber(lines: readonly string[], from: number, file: string | null): number | null {
  for (let index = from + 1; index < Math.min(from + 13, lines.length); index += 1) {
    const raw = (lines[index] ?? "").trim();
    if (raw.startsWith("!")) return null; // 下一个错块开始了，不再往后看
    const local = /^l\.(\d+)/.exec(raw);
    if (local !== null) return Number(local[1]);
    const prefixed = FILE_LINE_PREFIX.exec(raw);
    if (prefixed !== null && normalizeFile(prefixed[1] ?? "") === file) return Number(prefixed[2]);
  }
  return null;
}

/** 告警行里的 `on input line 42` */
function inputLineNumber(message: string): number | null {
  const match = /on input line (\d+)/.exec(message);
  return match === null ? null : Number(match[1]);
}

/** 版式行里的 `at lines 10--12` / `at line 7` */
function layoutLineNumber(message: string): number | null {
  const match = /at lines? (\d+)/.exec(message);
  return match === null ? null : Number(match[1]);
}

function cleanMessage(message: string): string {
  return message.trim().replace(/^!\s*/, "! ").replace(/\s+/g, " ");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** 这一行是不是上一条诊断的续行；是的话返回要拼进 message 的片段 */
function continuationOf(line: string): string | null {
  const match = CONTINUATION.exec(line.trim());
  if (match === null) return null;
  const body = (match[2] ?? "").trim();
  return body === "" ? null : body;
}

/**
 * 把 `file:line: msg` 之后的续行接到消息上。
 *
 * 两种形态：
 *  1. `(fontspec) …` / `(pdftex.def) …`：TeX 的宏包续行（带包名）；
 *  2. 79 列硬折行：上一行写满了，下一行是**裸的**半句（`…using draft s` / `etting.`）。
 *
 * 返回拼好的整句与吃掉的续行数。遇到别的东西（空行、`l.N`、下一条诊断）就停。
 */
function joinContinuations(
  lines: readonly string[],
  from: number,
): { text: string; consumed: number } {
  const parts: string[] = [];
  let consumed = 0;
  for (let index = from + 1; index < lines.length && consumed < MAX_CONTINUATION_LINES; index += 1) {
    const piece = continuationOf(lines[index] ?? "");
    if (piece === null) break;
    parts.push(piece);
    consumed += 1;
  }
  let text = parts.length === 0 ? "" : ` ${parts.join(" ")}`;
  // 79 列硬折行：只有上一条物理行写满了才可能是折行。**折点在词中间**，所以
  // 默认不加空格（`draft s` + `etting.` → `draft setting.`）；上一行以空白结尾时
  // 才补一个空格（TeX 在空格处折断的情况）。
  while (consumed < MAX_CONTINUATION_LINES) {
    const previous = lines[from + consumed] ?? "";
    if (previous.length < MAX_PRINT_LINE) break;
    const next = lines[from + consumed + 1];
    if (next === undefined || next.trim() === "" || isDiagnosticLike(next)) break;
    text = `${text}${/\s$/.test(previous) ? " " : ""}${next.trim()}`;
    consumed += 1;
  }
  return { text, consumed };
}

/** 这一行本身已经是一条独立日志行（下一行就该另起一条，不能当续行拼掉） */
function isDiagnosticLike(line: string): boolean {
  if (line.startsWith("!")) return true;
  if (/^l\.\d+/.test(line.trim())) return true;
  if (FILE_LINE_PREFIX.test(line)) return true;
  return classify(cleanMessage(line), false) !== null;
}

/**
 * 日志里的原始块：首行 + `l.N` 那一行（出错的 token 只在 `l.N` 的下一行里出现）。
 * 续行已经拼进 message，这里跳过它们；拿不到 `l.N` 时退化为后面几行非空文本。
 * 上限 4 行 / 400 字符，截断时以 `…` 结尾。
 */
function rawBlock(lines: readonly string[], from: number, consumed: number): string {
  const parts: string[] = [(lines[from] ?? "").trimEnd()];
  let anchor = -1;
  for (let index = from + 1; index < Math.min(from + consumed + 13, lines.length); index += 1) {
    if (/^l\.\d+/.test((lines[index] ?? "").trim())) {
      anchor = index;
      break;
    }
  }
  if (anchor >= 0) {
    parts.push((lines[anchor] ?? "").trimEnd());
    const next = lines[anchor + 1];
    if (next !== undefined && next.trim() !== "") parts.push(next.trimEnd());
  } else {
    for (let index = from + 1; index < lines.length && parts.length < 4; index += 1) {
      if (continuationOf(lines[index] ?? "") !== null) continue;
      const text = (lines[index] ?? "").trimEnd();
      if (text.trim() === "") break;
      parts.push(text);
    }
  }
  return clip(parts.slice(0, 4).join("\n"), MAX_RAW_CHARS);
}

interface Bucket {
  list: LatexIssue[];
  limit: number;
  omitted: number;
}

function pushIssue(bucket: Bucket, issue: LatexIssue, seen: Set<string>): boolean {
  const key = `${issue.file ?? ""}:${issue.line ?? ""}:${issue.message}`;
  // 去重先于计数：同一个错在多轮里重复出现不该把 omitted 撑起来
  if (seen.has(key)) return false;
  seen.add(key);
  if (bucket.list.length >= bucket.limit) {
    bucket.omitted += 1;
    return false;
  }
  bucket.list.push(issue);
  return true;
}

/**
 * 解析一份 .log。
 *
 * 去重键 `file:line:message`：latexmk 多轮之间会把同一个错原样再写一遍（尤其
 * `-interaction=nonstopmode` 下前一轮已经报过的），不去重的话模型会以为
 * 有 5 个不同的错。
 *
 * **errors / warnings / layout 各自独立计数与上限**：真实论文的 Overfull 可以上千条，
 * 与告警共用 200 的上限时，210 条 Overfull 会把「引用未定义」整条挤掉，status 还会
 * 变成 ok（本机真跑复现）。layout 也永远不会再占 warning 的名额。
 */
export function parseLatexLog(log: string): ParsedLatexLog {
  const lines = log.split(/\r?\n/);
  const diagnostics: LatexIssue[] = [];
  const seen = new Set<string>();
  const fileStack: (string | null)[] = [];
  const outputs: LoggedOutputItem[] = [];
  const buckets: Record<LatexIssueKind, Bucket> = {
    error: { list: [], limit: LATEX_MAX_ERRORS, omitted: 0 },
    warning: { list: [], limit: LATEX_MAX_WARNINGS, omitted: 0 },
    layout: { list: [], limit: LATEX_MAX_LAYOUT, omitted: 0 },
  };
  let errorCount = 0;
  let pages: number | null = null;
  let output: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    // 先更新括号栈（这一行里进入/离开的文件，对后面同一行的错也适用）
    trackFileStack(raw, fileStack);

    const prefixed = FILE_LINE_PREFIX.exec(raw);
    const file = prefixed === null ? null : normalizeFile(prefixed[1] ?? "");
    const line = prefixed === null ? null : Number(prefixed[2]);
    const message = cleanMessage(prefixed === null ? raw : (prefixed[3] ?? ""));
    if (message === "") continue;

    const kind = classify(message, prefixed !== null);
    if (kind === null) continue;

    if (kind === "info") {
      // `Output written on build/main.pdf (3 pages, 12345 bytes).` / 带引号的含空格路径
      const written = /^Output written on (.+?) \((\d+) pages?(?:,\s*(\d+) bytes)?/.exec(message);
      if (written !== null) {
        const path = (written[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
        const count = Number(written[2]);
        const bytes = written[3] === undefined ? null : Number(written[3]);
        outputs.push({ path, pages: count, bytes });
        // 旧字段的镜像：最后一条（与改动前的“后者覆盖前者”行为一致）
        pages = count;
        output = path;
      }
      continue;
    }

    // 折行拼回：`Package fontspec Error:` 的真句在下一行 `(fontspec) The font …`
    const joined = kind === "error" || kind === "warning" ? joinContinuations(lines, index) : { text: "", consumed: 0 };
    const fullMessage = cleanMessage(joined.text === "" ? message : `${message}${joined.text}`);

    const attributed = file ?? currentFile(fileStack);
    const issue: LatexIssue = {
      file: attributed,
      line:
        line ??
        (kind === "error" ? (missingLineNumber(lines, index) ?? nearbyLineNumber(lines, index, attributed)) : null) ??
        (kind === "layout" ? layoutLineNumber(message) : inputLineNumber(fullMessage)),
      message: clip(fullMessage, MAX_MESSAGE_CHARS),
      kind,
      code: diagnosticCodeOf(fullMessage, kind),
      column: null,
      source: "log",
      // 哪一步产生的：TeX 日志本身不写引擎名，run.ts 拿不到就不填（null 比编造好）
      step: null,
      raw: kind === "error" && errorCount < LATEX_RAW_ERRORS ? rawBlock(lines, index, joined.consumed) : null,
    };
    if (kind === "error") errorCount += 1;
    if (pushIssue(buckets[kind], issue, seen)) diagnostics.push(issue);

    // 续行已经并进这一条：跳过它们（括号栈照常更新，它们自己是配对的）
    if (joined.consumed > 0) {
      for (let skip = index + 1; skip <= index + joined.consumed; skip += 1) {
        trackFileStack(lines[skip] ?? "", fileStack);
      }
      index += joined.consumed;
    }
  }

  return {
    diagnostics,
    omitted: {
      errors: buckets.error.omitted,
      warnings: buckets.warning.omitted,
      layout: buckets.layout.omitted,
    },
    errors: buckets.error.list,
    warnings: [...buckets.warning.list, ...buckets.layout.list],
    outputs,
    pages,
    output,
  };
}

/**
 * 「有没有值得让用户停一下的告警」。版式（Overfull/Underfull）不算：几乎每篇
 * 真实论文都有，把它们算进 warning-only 会让这个状态失去信息量（见 shared/latex.ts
 * 的 LatexIssueKind 注释）。status 的判定在 run.ts，这里只给出判据。
 *
 * **截断后仍然为 true**：layout 有独立的上限，不会再把它挤掉。
 */
export function hasContentWarnings(warnings: readonly LatexIssue[]): boolean {
  return warnings.some((issue) => issue.kind !== "layout");
}
