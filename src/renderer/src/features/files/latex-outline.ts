/**
 * 文档大纲（章节树）—— 纯解析 + 「光标在第几节」的裁决。
 *
 * 只认章节命令（`\part` … `\subparagraph`），不把 `\label` / 浮动体塞进树里：论文的
 * 结构就是章节，label 属于 `\ref` 的补全与重复检测。层级用**相对缩进**（最浅的那一级
 * 从 0 开始），article 只有 `\section` 时不会莫名空两格。
 *
 * 标题里的 `\label{}` / `\index{}` 去掉，其余命令原样保留（作者认得出 `\textbf`）。
 * 跨行标题（花括号没闭合就换行）按花括号配对继续读，最多读到文末。
 */
import { stripTexComments } from "./tex-text.ts";

export interface OutlineEntry {
  /** 相对缩进层级（0 = 文档里最浅的章节级） */
  level: number;
  /** 命令名本身（part / section / subsection…），界面用它说「这是一节还是一章」 */
  command: string;
  title: string;
  /** 1 基行号 */
  line: number;
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

const SECTION = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?[ \t]*(?:\[[^\]\n]*\])?[ \t]*\{/g;

/** 从 `open` 位置的 `{` 开始配对，返回内容与闭合后的下标（不配对时读到末尾） */
function readBraced(text: string, open: number): { content: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1; // 跳过被转义的字符（\{ / \} / \\）
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { content: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return { content: text.slice(open + 1), end: text.length };
}

/** 标题的显示文本：去 label/index/footnote，去花括号，折叠空白 */
export function outlineTitle(raw: string): string {
  return raw
    .replace(/\\(?:label|index|footnote)\s*\{[^{}]*\}/g, "")
    .replace(/\\[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 文档 → 大纲条目（按出现顺序）。没有章节命令时返回空数组 */
export function parseOutline(text: string): OutlineEntry[] {
  const source = stripTexComments(text);
  const raw: { order: number; command: string; title: string; line: number }[] = [];

  // 行号按「命令出现在第几行」算：先建行起点表
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  for (const match of source.matchAll(SECTION)) {
    const command = match[1] ?? "";
    const at = match.index ?? 0;
    const open = at + match[0].length - 1;
    const braced = readBraced(source, open);
    raw.push({ order: at, command, title: outlineTitle(braced.content), line: lineAt(at) });
  }

  const minLevel = raw.reduce((min, entry) => Math.min(min, SECTION_LEVELS[entry.command] ?? 0), Infinity);
  return raw.map((entry) => ({
    level: Math.max(0, (SECTION_LEVELS[entry.command] ?? 0) - (minLevel === Infinity ? 0 : minLevel)),
    command: entry.command,
    title: entry.title === "" ? `\\${entry.command}` : entry.title,
    line: entry.line,
  }));
}

/**
 * 光标在第几节（大纲里高亮哪一条）：行号不超过光标的最后一条；在第一节之前时 -1。
 * 大纲只有几十条，线性扫足够，不必二分。
 */
export function outlineIndexAt(entries: readonly OutlineEntry[], line: number): number {
  let found = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.line <= line) found = i;
    else break;
  }
  return found;
}
