/**
 * PDF 标签的**纯视图逻辑**：产物事实 → 标签、开 / 关、并排裁决、按会话的记忆。
 *
 * 为什么要有这一层（2026-11 用户裁决）：PDF 不再是「有 LaTeX 项目就自己长出来的一块
 * 面板」，而是 cap-tabs 里的普通标签——能关、关掉第二栏就收、重新编译只刷新不重开。
 * 并排**只由有没有 PDF 标签决定**，不由布局（paperLayout）决定：Word / Excel / PPT
 * 没有 PDF 标签，因此也不会再被塞一块空白 PDF 面板。
 *
 * 独立成模块的理由同 latex-workbench.ts / paper-layout.ts：FilesPanel 连着 React 与
 * IPC，`node --test` 加载不了；这里全是输入 → 输出。
 */
import type { LatexOutput } from "@shared/latex";
import { pathTail, samePath } from "../../../../shared/path.ts";

/** 一个 PDF 标签的事实（产物路径是身份；标题只是末段） */
export interface PdfTabFact {
  /** 绝对路径 */
  path: string;
  /** 标签上显示的名字（路径末段：main.pdf） */
  label: string;
  /** 页数（回执 v2 的 outputs[].pages；没有日志证据时 null） */
  pages: number | null;
  /** 产物 mtime（标签 tooltip「刷新到哪一版」用） */
  modifiedAt: number | null;
}

/**
 * 这一刻该有哪些 PDF 标签：项目 PDF + 本次构建的全部 PDF 产物，按 `samePath` 去重
 * （primary / 项目 PDF 在前）。**多产物 = 每个产物一个标签**（比一个「PDF 组」简单：
 * 复用 cap-tabs 的关 / 激活语义，不需要再发明一层分组）。
 */
export function pdfTabFacts(input: {
  projectPdf: { path: string; modifiedAt: number | null } | null;
  outputs: readonly LatexOutput[] | null;
}): PdfTabFact[] {
  const facts: PdfTabFact[] = [];
  const push = (path: string, pages: number | null, modifiedAt: number | null): void => {
    if (facts.some((fact) => samePath(fact.path, path))) return;
    facts.push({ path, label: pathTail(path) || path, pages, modifiedAt });
  };
  if (input.projectPdf !== null) push(input.projectPdf.path, null, input.projectPdf.modifiedAt);
  for (const output of input.outputs ?? []) {
    if (output.kind !== "pdf") continue;
    push(output.path, output.pages, output.modifiedAt);
  }
  // 页数只出现在 outputs 里：项目 PDF 那条补一次（primary 的 pages 就是它的）
  return facts.map((fact) => {
    if (fact.pages !== null) return fact;
    const match = (input.outputs ?? []).find((output) => output.kind === "pdf" && samePath(output.path, fact.path));
    return match === undefined ? fact : { ...fact, pages: match.pages };
  });
}

/**
 * 事实变了之后，还开着哪些 PDF 标签。
 *
 * - 产物还在 → 只留下还存在的（重新编译换了 outDir / jobname 时，旧标签自然退场）；
 * - 一个都不剩、且**用户没关过**（collapsed=false）→ 自动打开全部产物：
 *   新项目 / 第一次编出 PDF 时 PDF 标签就该在场；
 * - 用户关过 → 保持关着（哪怕又编了一版）：关掉是明确的意愿，不该被下一次编译推翻。
 */
export function reconcilePdfTabs(input: {
  open: readonly string[];
  facts: readonly PdfTabFact[];
  /** 这个会话里用户主动关掉过 PDF 标签 */
  collapsed: boolean;
}): string[] {
  if (input.facts.length === 0) return [];
  const kept: string[] = [];
  for (const path of input.open) {
    const match = input.facts.find((fact) => samePath(fact.path, path));
    if (match !== undefined && !kept.includes(match.path)) kept.push(match.path);
  }
  if (kept.length > 0) return kept;
  if (input.collapsed) return [];
  return input.facts.map((fact) => fact.path);
}

/** 关一个 PDF 标签（关掉最后一个 = 第二栏收掉）。返回新数组，不改传入值 */
export function closePdfTab(open: readonly string[], path: string): string[] {
  return open.filter((item) => !samePath(item, path));
}

/**
 * 右栏该显示哪一份 PDF：激活的 PDF 标签优先（多产物时用户点过哪一个），否则第一个。
 * null = 没有开着的 PDF 标签 → 不并排。
 */
export function pdfPanePathOf(input: {
  open: readonly string[];
  facts: readonly PdfTabFact[];
  activePdfPath: string | null;
}): string | null {
  const available = input.open.filter((path) => input.facts.some((fact) => samePath(fact.path, path)));
  if (available.length === 0) return null;
  const activePdfPath = input.activePdfPath;
  if (activePdfPath !== null) {
    const active = available.find((path) => samePath(path, activePdfPath));
    if (active !== undefined) return active;
  }
  return available[0] ?? null;
}

/**
 * 要不要并排：**只看有没有 PDF 标签**（有 pane）与左栏有没有可显示的文件。
 * 布局（paperLayout）/ 窗口宽都不在这里——那两条以前会让 Word 也长出一块空白 PDF。
 */
export function pdfSplitOf(input: { panePath: string | null; sourcePath: string | null }): boolean {
  if (input.panePath === null || input.sourcePath === null) return false;
  return !samePath(input.panePath, input.sourcePath);
}

/** 每个会话记住「用户关掉过 PDF 标签」：只存内存（与 paper-layout 的记忆同一条纪律） */
export type PdfTabMemory = ReadonlyMap<string, boolean>;

/** 记下一条会话的 PDF 标签开合（true = 用户关掉了）。返回新 Map，不改传入值 */
export function rememberPdfCollapsed(
  memory: PdfTabMemory,
  sessionKey: string,
  collapsed: boolean,
): Map<string, boolean> {
  const next = new Map(memory);
  next.set(sessionKey, collapsed);
  return next;
}

/** 取一条会话记忆：没记过 = 没关过（false，新会话里 PDF 标签可以自动出现） */
export function recallPdfCollapsed(memory: PdfTabMemory, sessionKey: string): boolean {
  return memory.get(sessionKey) ?? false;
}
