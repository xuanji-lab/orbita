/**
 * pandoc 的 argv 拼装 —— 纯函数，测试直接钉「给什么源文件、出什么参数」。
 *
 * 几条定死的选择：
 *
 * - **不传 `--number-sections`**：章节号由标题文字自己带（论文模板里通常已经是
 *   「1 引言」），pandoc 再自动编号会变成「1 1 引言」。这是计划里点名的一条。
 * - **目录 / 图目录 / 表目录一律先让 pandoc 生成，再由后处理按产物裁掉空的那几节**：
 *   源里的正则猜「有没有表」会猜错（LaTeX 表格 pandoc 根本不解析、Markdown 表格没有
 *   题注），结果是一个空的「List of Tables」标题。`pruneEmptyLists` 看产物里真实的
 *   标题 / 表格 / 图片 / 题注数量，没有内容就整节删掉。
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
  /** 源文件正文（只用来判断有没有引用，不参与转换） */
  text: string;
  sourcePath: string;
  outPath: string;
  /** 模板 docx 的绝对路径；null = 不用 --reference-doc（pandoc 自带默认样式） */
  referenceDoc: string | null;
}

export interface PandocPlan {
  args: string[];
  citeproc: boolean;
  /** pandoc 的 --from 值 */
  from: "gfm" | "latex";
}

export function detectInputFormat(path: string): DocxInputFormat | null {
  if (/\.(?:md|markdown)$/i.test(path)) return "markdown";
  if (/\.tex$/i.test(path)) return "latex";
  return null;
}

function hasCitations(format: DocxInputFormat, text: string): boolean {
  return format === "markdown"
    ? /(?:^|[\s[(])@[\w:.#$%&+?<>~/-]+/.test(text) || /\[@[^\]]+\]/.test(text)
    : /\\(?:cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite)\*?\s*(?:\[[^\]]*\])*\s*\{/.test(text);
}

/**
 * LaTeX 表格环境。pandoc 的 LaTeX 读取器**不解析**这些环境（3.9 与 3.12.1 实测：
 * `\begin{tabular}` 会变成普通段落 / raw），产物里只剩 `lcc 方法 & 准确率 …` 这种字面行。
 * 与其静默产出一份学校不能用的 docx，不如在转换前明确失败（见 export.ts 的 table-degraded）。
 */
const LATEX_TABLE_ENVIRONMENTS = ["tabular", "tabularx", "tabulary", "longtable", "tabu"] as const;

export function latexTableEnvironments(text: string): string[] {
  const found = new Set<string>();
  for (const name of LATEX_TABLE_ENVIRONMENTS) {
    if (new RegExp(`\\\\begin\\s*\\{${name}\\*?\\}`).test(text)) found.add(name);
  }
  // `\begin{table}` 本身不一定是表格（可能只放图），但里面出现 tabular 时上面的正则已经命中；
  // 只有 table 环境而没有 tabular 的，交给 pandoc 的普通转换即可
  return [...found];
}

export function buildPandocArgs(options: PandocArgvOptions): PandocPlan {
  const { format, text, sourcePath, outPath, referenceDoc } = options;
  const citeproc = hasCitations(format, text);
  const from = format === "markdown" ? "gfm" : "latex";

  const args = ["--from", from, "--to", "docx", "--output", outPath];
  if (referenceDoc !== null) args.push(`--reference-doc=${referenceDoc}`);
  if (citeproc) args.push("--citeproc");
  // 三节目录都先要；有没有内容由 pruneEmptyLists 按产物裁（见文件头）
  args.push("--toc", "--lof", "--lot");
  // 显式写出资源根：图 / .bib 的相对路径按源文件目录解析，而不是引擎的 cwd
  args.push(`--resource-path=${resourceDir(sourcePath)}`);
  args.push(sourcePath);
  return { args, citeproc, from };
}

function resourceDir(sourcePath: string): string {
  const index = Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\"));
  return index <= 0 ? "." : sourcePath.slice(0, index);
}
