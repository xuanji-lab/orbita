/**
 * LaTeX 源码的**折叠**（章节块与环境块）。
 *
 * 为什么在 renderer 里算而不问主进程：折叠只跟「眼前这份文档」有关，用户每打一个字
 * 都可能变；走 IPC 会让折叠比打字慢一拍。算法是纯字符串扫描（`node --test` 覆盖），
 * 剔除注释后按行看 `\section` 家族与 `\begin/\end` 配对（同名环境可以嵌套）。
 *
 * 两种块：
 * - **章节块**：`\part` … `\subparagraph`，折到下一个同级或更高级标题之前；没有下一个
 *   就折到 `\end{document}`（或文末）。标题行本身始终可见。
 * - **环境块**：`\begin{x}` 与配对的 `\end{x}`，折到 `\end` 行之前。`\begin` / `\end`
 *   同一行的不折（没有可折的内容）。
 *
 * 折叠区间由 StateField 在文档变化时算一次，`foldService` 只做「这一行有没有折点」的
 * 查表——逐行重扫整篇会让长文档的滚动发涩。
 */
import { foldService } from "@codemirror/language";
import { StateField, type EditorState, type Extension } from "@codemirror/state";
import { stripTexComments } from "./tex-text.ts";

/** 一个折叠区间：`from` 是折点（起始行末），`to` 是折到的位置；`startLineFrom` 用于按行查表 */
export interface FoldRange {
  from: number;
  to: number;
  /** 折点所在行的起点（`foldService` 拿到的 lineStart 就是它） */
  startLineFrom: number;
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const SECTION = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?[ \t]*(?:\[[^\]\n]*\])?[ \t]*\{/;
const BEGIN = /\\begin\s*\{([^{}]+)\}/g;
const END = /\\end\s*\{([^{}]+)\}/g;
const END_DOCUMENT = /\\end\s*\{\s*document\s*\}/;

interface Line {
  /** 行起点 */
  from: number;
  /** 行内容（不含换行） */
  text: string;
  /** 行尾位置（换行之前；末行等于文档长度） */
  to: number;
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (true) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) {
      out.push({ from: start, text: text.slice(start), to: text.length });
      break;
    }
    // CRLF 的 \r 属于行内容，但行尾按去掉 \r 算
    const lineText = text.slice(start, newline).replace(/\r$/, "");
    out.push({ from: start, text: lineText, to: start + lineText.length });
    start = newline + 1;
    if (start > text.length) break;
  }
  return out;
}

/** 文档 → 所有折叠区间（按起点排序）。纯函数，供 StateField 与测试共用 */
export function foldRangesFor(text: string): FoldRange[] {
  const stripped = stripTexComments(text);
  const lines = linesOf(stripped);
  const ranges: FoldRange[] = [];

  // 章节块：先收所有标题，再往后找下一个同级 / 更高级
  const headings: { level: number; index: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = SECTION.exec(lines[index]?.text ?? "");
    if (match === null) continue;
    const level = SECTION_LEVELS[match[1] ?? ""];
    if (level === undefined) continue;
    headings.push({ level, index });
  }
  const endDocumentIndex = lines.findIndex((line) => END_DOCUMENT.test(line.text));
  for (let at = 0; at < headings.length; at += 1) {
    const current = headings[at];
    if (current === undefined) continue;
    const startLine = lines[current.index];
    if (startLine === undefined) continue;
    let stopIndex = lines.length;
    for (let next = at + 1; next < headings.length; next += 1) {
      const candidate = headings[next];
      if (candidate === undefined) continue;
      if (candidate.level <= current.level) {
        stopIndex = candidate.index;
        break;
      }
    }
    if (endDocumentIndex > current.index && endDocumentIndex < stopIndex) stopIndex = endDocumentIndex;
    const stopLine = lines[stopIndex];
    const to = stopLine === undefined ? text.length : stopLine.from;
    // 折点之后至少要有一行可藏：紧接着就是下一个标题时不折
    if (to > startLine.to + 1) {
      ranges.push({ from: startLine.to, to, startLineFrom: startLine.from });
    }
  }

  // 环境块：栈里放「还没闭合的 \begin」，同名环境可以嵌套
  const stack: { name: string; line: Line }[] = [];
  for (const line of lines) {
    for (const match of line.text.matchAll(BEGIN)) {
      const name = (match[1] ?? "").trim();
      if (name !== "") stack.push({ name, line });
    }
    for (const match of line.text.matchAll(END)) {
      const name = (match[1] ?? "").trim();
      let found = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]?.name === name) {
          found = i;
          break;
        }
      }
      if (found < 0) continue;
      const open = stack[found];
      stack.length = found;
      if (open === undefined) continue;
      // 同一行上的 begin/end 没有可藏的内容
      if (open.line.from === line.from) continue;
      if (line.from > open.line.to + 1) {
        ranges.push({ from: open.line.to, to: line.from, startLineFrom: open.line.from });
      }
    }
  }

  return ranges.sort((a, b) => a.from - b.from);
}

/** 文档变化时重算的折叠表 */
const foldField = StateField.define<readonly FoldRange[]>({
  create: (state: EditorState) => foldRangesFor(state.doc.toString()),
  update(ranges, transaction) {
    return transaction.docChanged ? foldRangesFor(transaction.state.doc.toString()) : ranges;
  },
});

/** 这一行有没有折点（按行起点查表） */
function foldAt(ranges: readonly FoldRange[], lineStart: number): FoldRange | null {
  for (const range of ranges) {
    if (range.startLineFrom === lineStart) return range;
    if (range.startLineFrom > lineStart) break;
  }
  return null;
}

/** 折叠服务 + 状态字段。只对 .tex 挂（.bib 没有章节 / 环境） */
export const latexFolding: Extension[] = [
  foldField,
  foldService.of((state: EditorState, lineStart: number) => {
    const range = foldAt(state.field(foldField), lineStart);
    return range === null ? null : { from: range.from, to: range.to };
  }),
];
