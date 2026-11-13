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
import { LATEX_MAX_ISSUES, type LatexIssue, type LatexIssueKind } from "../../shared/latex.ts";

export interface ParsedLatexLog {
  errors: LatexIssue[];
  warnings: LatexIssue[];
  /** `Output written on … (N pages` 的 N */
  pages: number | null;
  /**
   * `Output written on <path> (N pages` 里的 <path>。**产物不一定在 -outdir**：
   * 自定义 recipe 可以不传 -outdir，PDF / log 就落在主文件旁边。run.ts 拿它
   * 定位真实产物，找不到才回退到候选目录（评审 M2）。
   */
  output: string | null;
}

/** 夹带文件名的行：`./main.tex:5: …`、`C:\paper\main.tex:5: …`（贪婪匹配取最后一个 :数字: 对） */
const FILE_LINE_PREFIX = /^(.+):(\d+):\s*(.*)$/;

/** 能进括号栈的扩展名。TeX 的括号嵌套对任意文件都成立，但只认这些才不会被正文里的括号带偏 */
const TRACKED_FILE = /^([^\s(){}]+\.(?:tex|sty|cls|def|cfg|clo|fd|aux|bbl|toc|out|ind))/i;

/**
 * 括号栈：TeX 在 .log 里用 `(./sections/intro.tex` 表示「进入了这个文件」、
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

function pushIssue(list: LatexIssue[], issue: LatexIssue, seen: Set<string>): void {
  if (list.length >= LATEX_MAX_ISSUES) return;
  const key = `${issue.file ?? ""}:${issue.line ?? ""}:${issue.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(issue);
}

/**
 * 解析一份 .log。
 *
 * 去重键 `file:line:message`：latexmk 多轮之间会把同一个错原样再写一遍（尤其
 * `-interaction=nonstopmode` 下前一轮已经报过的），不去重的话模型会以为
 * 有 5 个不同的错。上限 200（LATEX_MAX_ISSUES）：真实论文的 Overfull 可以上千条。
 */
export function parseLatexLog(log: string): ParsedLatexLog {
  const lines = log.split(/\r?\n/);
  const errors: LatexIssue[] = [];
  const warnings: LatexIssue[] = [];
  const seen = new Set<string>();
  const fileStack: (string | null)[] = [];
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
      const written = /^Output written on (.+?) \((\d+) pages?/.exec(message);
      if (written !== null) {
        pages = Number(written[2]);
        const path = (written[1] ?? "").trim();
        output = path.replace(/^"(.*)"$/, "$1");
      }
      continue;
    }

    const attributed = file ?? currentFile(fileStack);
    const issue: LatexIssue = {
      file: attributed,
      line:
        line ??
        (kind === "error" ? (missingLineNumber(lines, index) ?? nearbyLineNumber(lines, index, attributed)) : null) ??
        (kind === "layout" ? layoutLineNumber(message) : inputLineNumber(message)),
      message,
      kind,
    };
    if (kind === "error") pushIssue(errors, issue, seen);
    else pushIssue(warnings, issue, seen);
  }

  return { errors, warnings, pages, output };
}

/**
 * 「有没有值得让用户停一下的告警」。版式（Overfull/Underfull）不算：几乎每篇
 * 真实论文都有，把它们算进 warning-only 会让这个状态失去信息量（见 shared/latex.ts
 * 的 LatexIssueKind 注释）。status 的判定在 run.ts，这里只给出判据。
 */
export function hasContentWarnings(warnings: readonly LatexIssue[]): boolean {
  return warnings.some((issue) => issue.kind !== "layout");
}
