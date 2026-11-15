/**
 * pandoc 的 argv 拼装 —— 纯函数，测试直接钉「给什么源文件、出什么参数」。
 *
 * 几条定死的选择：
 *
 * - **不传 `--number-sections`**：章节号由标题文字自己带（论文模板里通常已经是
 *   「1 引言」），pandoc 再自动编号会变成「1 1 引言」。这是计划里点名的一条。
 * - **目录 / 图目录 / 表目录按输入有没有来定**：pandoc 对 docx 会写成 TOC 域
 *   （`TOC \o "1-3" \h \z \u` / `TOC \h \z \t "Image Caption" \c`），打开后由
 *   folio 的目录自愈或 Word 的 F9 补页码；源里没有标题时插一个空目录只是噪音。
 * - **`--citeproc` 只在源里像是有引用时传**：没有 `.bib` 的文档跑 citeproc 会多一条
 *   「找不到文献」告警，把真正的告警淹掉。
 * - **`.tex` 走 `latex` 读取器、`.md` 走 `gfm`**：GFM 是 CommonMark + 表格 + 任务列表，
 *   比 pandoc 的 markdown 扩展少一点魔法，作者写 GitHub 风格时结果最可预期。
 * - 输入文件用绝对路径、工作目录设成源文件所在目录：`--resource-path` 同时给出
 *   源目录，`![](...)` 与 `\includegraphics{}` 的相对路径才解析得到。
 */
import type { DocxInputFormat } from "../../shared/docx-export.ts";

export interface PandocArgvOptions {
  format: DocxInputFormat;
  /** 源文件正文（只用来判断有没有标题 / 图 / 表 / 引用，不参与转换） */
  text: string;
  sourcePath: string;
  outPath: string;
  /** 模板 docx 的绝对路径；null = 不用 --reference-doc（pandoc 自带默认样式） */
  referenceDoc: string | null;
}

export interface PandocPlan {
  args: string[];
  /** 自动加进去的目录（报告里回显；也便于测试） */
  lists: { toc: boolean; figures: boolean; tables: boolean };
  citeproc: boolean;
  /** pandoc 的 --from 值 */
  from: "gfm" | "latex";
}

export function detectInputFormat(path: string): DocxInputFormat | null {
  if (/\.(?:md|markdown)$/i.test(path)) return "markdown";
  if (/\.tex$/i.test(path)) return "latex";
  return null;
}

function hasHeadings(format: DocxInputFormat, text: string): boolean {
  return format === "markdown" ? /^ {0,3}#{1,6}\s+\S/m.test(text) : /\\(?:section|chapter|part)\*?\s*\{/.test(text);
}

function hasFigures(format: DocxInputFormat, text: string): boolean {
  return format === "markdown"
    ? /!\[[^\]]*\]\([^)]+\)/.test(text) || /!\[\[[^\]]+\]\]/.test(text)
    : /\\(?:begin\s*\{figure|includegraphics)\b/.test(text);
}

function hasTables(format: DocxInputFormat, text: string): boolean {
  return format === "markdown"
    ? /^\s*\|?[^\n|]*\|[^\n]*\n\s*\|?\s*:?-{2,}/m.test(text)
    : /\\(?:begin\s*\{(?:table|tabular)|hline)\b/.test(text);
}

function hasCitations(format: DocxInputFormat, text: string): boolean {
  return format === "markdown"
    ? /(?:^|[\s[(])@[\w:.#$%&+?<>~/-]+/.test(text) || /\[@[^\]]+\]/.test(text)
    : /\\(?:cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite)\*?\s*(?:\[[^\]]*\])*\s*\{/.test(text);
}

export function buildPandocArgs(options: PandocArgvOptions): PandocPlan {
  const { format, text, sourcePath, outPath, referenceDoc } = options;
  const toc = hasHeadings(format, text);
  const figures = hasFigures(format, text);
  const tables = hasTables(format, text);
  const citeproc = hasCitations(format, text);
  const from = format === "markdown" ? "gfm" : "latex";

  const args = ["--from", from, "--to", "docx", "--output", outPath];
  if (referenceDoc !== null) args.push(`--reference-doc=${referenceDoc}`);
  if (citeproc) args.push("--citeproc");
  if (toc) args.push("--toc");
  if (figures) args.push("--lof");
  if (tables) args.push("--lot");
  // 显式写出资源根：图 / .bib 的相对路径按源文件目录解析，而不是引擎的 cwd
  args.push(`--resource-path=${resourceDir(sourcePath)}`);
  args.push(sourcePath);
  return { args, lists: { toc, figures, tables }, citeproc, from };
}

function resourceDir(sourcePath: string): string {
  const index = Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\"));
  return index <= 0 ? "." : sourcePath.slice(0, index);
}
