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
import { samePath } from "../../../../shared/path.ts";
import type { LatexNav } from "../../../../shared/latex.ts";
import { stripTexComments } from "./tex-text.ts";

export interface OutlineEntry {
  /** 相对缩进层级（0 = 文档里最浅的章节级） */
  level: number;
  /** 命令名本身（part / section / subsection…），界面用它说「这是一节还是一章」 */
  command: string;
  title: string;
  /** 1 基行号 */
  line: number;
  /**
   * 来源文件绝对路径。**只在跨文件聚合时有它**（单文件大纲的旧形状不带）。
   * 点击时用它决定「跳到另一个文件」还是本地跳行。
   */
  file?: string;
  /** 来源文件相对项目目录的路径（正斜杠）；与 file 同时出现，界面标「来自哪个文件」 */
  display?: string;
}

/** 正文里的一条章节标题（绝对层级；归一视图是下面 parseOutline 的事） */
export interface RawSection {
  command: string;
  title: string;
  /** 绝对层级：part=0 … subparagraph=6 */
  level: number;
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

/** 文档 → 大纲条目（按出现顺序、层级按本文件最浅一级归零）。没有章节命令时返回空数组 */
export function parseOutline(text: string): OutlineEntry[] {
  return normalizeLevels(
    parseSections(text).map((section) => ({
      level: section.level,
      command: section.command,
      title: section.title,
      line: section.line,
    })),
  );
}

/** 单文件大纲的缩进基准：最浅的那一级从 0 开始（article 只有 \section 时不空两格） */
function normalizeLevels(entries: OutlineEntry[]): OutlineEntry[] {
  const minLevel = entries.reduce((min, entry) => Math.min(min, entry.level), Infinity);
  return entries.map((entry) => ({ ...entry, level: Math.max(0, entry.level - (minLevel === Infinity ? 0 : minLevel)) }));
}

/**
 * 文档 → 章节标题（**绝对层级**，行号 1 基）。
 *
 * 与主进程的 `extractSections`（main/latex/index.ts）同一套规则：那份读盘上的
 * 其它文件，这份读编辑器里的活文本——刚敲的标题不该等 4 秒后的轮询。
 */
export function parseSections(text: string): RawSection[] {
  const source = stripTexComments(text);
  const sections: RawSection[] = [];

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
    const title = outlineTitle(readBraced(source, open).content);
    sections.push({
      level: SECTION_LEVELS[command] ?? 0,
      command,
      title: title === "" ? `\\${command}` : title,
      line: lineAt(at),
    });
  }
  return sections;
}

/** 聚合的原料：一个文件在包含图里的样子（章节 + 包含命令，都带行号） */
export interface OutlineSource {
  /** 绝对路径 */
  path: string;
  /** 相对项目目录（界面显示） */
  display: string;
  sections: readonly RawSection[];
  /** 只留解析得到的边；unresolved 不参与展开 */
  includes: readonly { line: number; target: string | null }[];
}

/** 聚合条目上限：400 节已经是一篇巨著的目录，再长的大纲没人读 */
const MAX_AGGREGATE_ENTRIES = 400;

/** 聚合深度上限（与主进程的包含图上限一致；图已经剪过一遍，这里只管自己不走飞） */
const MAX_AGGREGATE_DEPTH = 8;

/**
 * 整篇大纲：从 `root` 开始，按**展开后的文档顺序**走。
 *
 * 一个文件的章节与它的包含命令按行号合并排序——LaTeX 的阅读顺序就是它们在源码里的
 * 出现顺序（`\section{Intro}` 在 `\input{sec/ch1}` 之前就在前面），不是「先本文件
 * 所有章节、再所有子文件」。环与菱形包含用路径栈挡：同一个文件不会在自己的子树里
 * 再展开一次（真实文档里重复包含本来就是错的，图里已记进 limits）。
 *
 * 层级在整篇拼完后归一：最浅的那一级缩进为 0，否则一本书（chapter 最浅）与一篇文章
 * （section 最浅）混在同一棵树里会差一级。
 */
export function aggregateOutline(root: string, sources: readonly OutlineSource[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];

  const walk = (path: string, stack: readonly string[], depth: number): void => {
    if (entries.length >= MAX_AGGREGATE_ENTRIES || depth > MAX_AGGREGATE_DEPTH) return;
    const source = sources.find((candidate) => samePath(candidate.path, path));
    if (source === undefined) return;

    // 0 = 章节，1 = 包含命令：同一行上的先后按这个排（很少见，但要定死）
    const items: { line: number; kind: 0 | 1; index: number }[] = [
      ...source.sections.map((section, index) => ({ line: section.line, kind: 0 as const, index })),
      ...source.includes.flatMap((edge, index) =>
        edge.target === null ? [] : [{ line: edge.line, kind: 1 as const, index }],
      ),
    ].sort((a, b) => a.line - b.line || a.kind - b.kind || a.index - b.index);

    for (const item of items) {
      if (entries.length >= MAX_AGGREGATE_ENTRIES) return;
      if (item.kind === 0) {
        const section = source.sections[item.index];
        if (section === undefined) continue;
        entries.push({
          level: section.level,
          command: section.command,
          title: section.title,
          line: section.line,
          file: source.path,
          display: source.display,
        });
        continue;
      }
      const target = source.includes[item.index]?.target ?? null;
      if (target === null) continue;
      if (stack.some((seen) => samePath(seen, target))) continue;
      walk(target, [...stack, target], depth + 1);
    }
  };

  walk(root, [root], 0);
  return normalizeLevels(entries);
}

/**
 * 大纲抽屉要显示的东西 + 它属于哪个 root。
 *
 * 聚合只在「当前文件落在某个 root 里」时发生；没有 root / root 解析失败 / 导航
 * 还没回来时退回单文件大纲（旧行为）。当前文件的章节**永远用编辑器里的活文本**：
 * 刚改的标题不该等下一条 IPC。
 */
export function outlineView(input: {
  /** 编辑器里的当前文本 */
  text: string;
  /** 当前文件绝对路径 */
  path: string;
  nav: LatexNav | null;
}): { entries: OutlineEntry[]; rootLabel: string | null } {
  const nav = input.nav;
  if (nav === null || nav.rootPath === null || nav.root === null) {
    return { entries: parseOutline(input.text), rootLabel: null };
  }
  const live = parseSections(input.text);
  const sources: OutlineSource[] = nav.files.map((file) => ({
    path: file.path,
    display: file.display,
    sections: samePath(file.path, input.path) ? live : file.sections,
    includes: file.includes.map((edge) => ({ line: edge.line, target: edge.target })),
  }));
  return { entries: aggregateOutline(nav.rootPath, sources), rootLabel: nav.root };
}

/**
 * 光标在第几节（大纲里高亮哪一条）：行号不超过光标的最后一条；在第一节之前时 -1。
 *
 * 跨文件聚合时传 `file`：别的文件的同一行号与这个光标无关，不能参与比较。
 * 大纲只有几十条，线性扫足够，不必二分。
 */
export function outlineIndexAt(entries: readonly OutlineEntry[], line: number, file?: string): number {
  let found = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (file !== undefined && entry.file !== undefined && !samePath(entry.file, file)) continue;
    if (entry.line <= line) found = i;
    else break;
  }
  return found;
}
