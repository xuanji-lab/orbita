/**
 * LaTeX 编译配方（预设）——**编译条 chip 菜单里那 9 条**的唯一真源。
 *
 * 为什么在 shared：renderer 要画菜单（id / label / 分组 / 推荐标记 / 能不能清理），
 * 主进程要照它展开成真正的命令（见 main/latex/resolve.ts 的 buildSteps），
 * 两处必须读同一张表——否则「菜单写着 xelatex、实际跑的是 pdflatex」这类错位
 * 没有任何地方会报错。
 *
 * 一条配方 = `{id, label, group, steps[]}`：
 * - `steps` 是**顺序执行的工具链**（相邻工具之间由我们串起来，见 run.ts）；
 *   每一步是「工具 + 参数」，不是一整条 shell 字符串（Windows 上也没有 shell）。
 * - 参数里的占位符由 resolve.ts 的 expandRecipe 展开：
 *   `%DOC%`（主文件名去扩展名）/ `%DOCFILE%`（主文件名）/ `%JOB%`（jobname，缺省同 %DOC%）/
 *   `%DIR%`（工作目录）/ `%OUTDIR%`（产物目录绝对路径）/ `%OUTREL%`（产物目录相对工作目录）。
 *
 * **为什么要有 `%OUTREL%`**：makeindex / bibtex 走 kpathsea，`openout_any=p` 拒绝写
 * 绝对输出路径（真机实测 `Not writing to C:\…\main.ind`）；写成相对路径就没事。
 * - `tool: "%ENGINE%"` 的只有「单次编译」：它跑的引擎由这次解析出的引擎决定
 *   （xelatex / pdflatex / lualatex），因此三个引擎共用一条预设、一个 id。
 *
 * 边界：这里不判「本机装没装」（probe 的事），也不写 `.orbita/latex.json`
 * （project.ts 的事）。`cleanable` 只说这条链是不是 latexmk 系——`-c` 是 latexmk
 * 的功能，手写 / 单次链没有它。
 */
import type { LatexEngine } from "./latex.ts";

/** 菜单分组（顺序 = 菜单里出现的顺序，见 LATEX_RECIPE_GROUPS） */
export type LatexRecipeGroup = "recommended" | "index" | "glossary" | "manual" | "debug" | "special";

/** 菜单分组的固定顺序（界面按它排版，不在组件里另写一份） */
export const LATEX_RECIPE_GROUPS: readonly LatexRecipeGroup[] = [
  "recommended",
  "index",
  "glossary",
  "manual",
  "debug",
  "special",
];

export interface LatexRecipeStep {
  /** 可执行文件名（PATH 上的名字）；`%ENGINE%` 由解析时的引擎替换 */
  tool: string;
  /** 展开占位符之前的参数表（可执行文件本身不展开） */
  args: string[];
}

export interface LatexRecipePreset {
  /** 写进 `.orbita/latex.json` 的 `recipeId`；**一旦发布就不能改**（旧配置指着它） */
  id: string;
  /** 菜单 / chip 上的命令链写法（技术词，不放中文：latexmk / xelatex 是工具名） */
  label: string;
  group: LatexRecipeGroup;
  /**
   * 这条配方自己决定的引擎；null = 跟随项目（只有「单次编译」用 %ENGINE%）。
   * 选配方就选了引擎：推荐组的三条名字里已经写着 xelatex / pdflatex / lualatex。
   */
  engine: LatexEngine | null;
  steps: LatexRecipeStep[];
  /** 推荐标记（菜单里带「推荐」小字）：新项目缺省的那几条 */
  recommended?: boolean;
  /** latexmk -c 能不能清（只有 latexmk 系；手写 / 单次链清不了） */
  cleanable: boolean;
}

/** latexmk 的公共参数：与默认链一致（非交互、file:line 错误、SyncTeX、产物目录） */
const LATEXMK_COMMON = ["-interaction=nonstopmode", "-file-line-error", "-synctex=1", "-outdir=%OUTDIR%", "%DOCFILE%"];

/**
 * 单次引擎的公共参数。**`-output-directory` 不是 latexmk 的 `-outdir`**：latexmk
 * 认自己的短写，TeX 引擎只认 `-output-directory`——写成 -outdir 时引擎会当它不存在，
 * 把 PDF 悄悄写回主文件旁边（真机实测：single-pass 的产物落在项目根而不是 build/）。
 */
const ENGINE_COMMON = [
  "-interaction=nonstopmode",
  "-file-line-error",
  "-synctex=1",
  "-output-directory=%OUTDIR%",
  "%DOCFILE%",
];

const latexmk = (flag: string, ...extra: string[]): LatexRecipeStep => ({
  tool: "latexmk",
  args: [flag, ...extra, ...LATEXMK_COMMON],
});

const engineRun = (tool: string): LatexRecipeStep => ({ tool, args: [...ENGINE_COMMON] });

/**
 * 9 条预设。id 是落盘契约：`latexmk-xelatex` / `latexmk-pdflatex` / `latexmk-lualatex` /
 * `latexmk-makeindex` / `latexmk-glossaries` / `manual-xelatex-biber` /
 * `manual-pdflatex-bibtex` / `single-pass` / `latexmk-shell-escape`。
 */
export const LATEX_RECIPE_PRESETS: readonly LatexRecipePreset[] = [
  {
    id: "latexmk-xelatex",
    label: "latexmk · xelatex",
    group: "recommended",
    engine: "xelatex",
    steps: [latexmk("-xelatex")],
    recommended: true,
    cleanable: true,
  },
  {
    id: "latexmk-pdflatex",
    label: "latexmk · pdflatex",
    group: "recommended",
    engine: "pdf",
    steps: [latexmk("-pdf")],
    recommended: true,
    cleanable: true,
  },
  {
    id: "latexmk-lualatex",
    label: "latexmk · lualatex",
    group: "recommended",
    engine: "lualatex",
    steps: [latexmk("-lualatex")],
    recommended: true,
    cleanable: true,
  },
  {
    id: "latexmk-makeindex",
    label: "latexmk · xelatex → makeindex → latexmk",
    group: "index",
    engine: "xelatex",
    // 收尾那一趟必须有：makeindex 写入的 .ind 要再排一次才会进 PDF
    steps: [
      latexmk("-xelatex"),
      // 相对路径（cwd = 主文件目录）：kpathsea 的 openout_any=p 会拒绝写绝对输出路径
      { tool: "makeindex", args: ["-o", "%OUTREL%/%JOB%.ind", "%OUTREL%/%JOB%.idx"] },
      latexmk("-xelatex"),
    ],
    cleanable: true,
  },
  {
    id: "latexmk-glossaries",
    label: "latexmk · xelatex → makeglossaries → latexmk",
    group: "glossary",
    engine: "xelatex",
    steps: [
      latexmk("-xelatex"),
      { tool: "makeglossaries", args: ["-d", "%OUTREL%", "%JOB%"] },
      latexmk("-xelatex"),
    ],
    cleanable: true,
  },
  {
    id: "manual-xelatex-biber",
    label: "xelatex → biber → xelatex ×2",
    group: "manual",
    engine: "xelatex",
    // ×2：biber 写完 .bbl 后要两趟才把交叉引用与页码收敛（通行做法，不是凑数）
    steps: [
      engineRun("xelatex"),
      { tool: "biber", args: ["--output-directory=%OUTREL%", "%JOB%"] },
      engineRun("xelatex"),
      engineRun("xelatex"),
    ],
    cleanable: false,
  },
  {
    id: "manual-pdflatex-bibtex",
    label: "pdflatex → bibtex → pdflatex ×2",
    group: "manual",
    engine: "pdf",
    steps: [
      engineRun("pdflatex"),
      { tool: "bibtex", args: ["%OUTREL%/%JOB%"] },
      engineRun("pdflatex"),
      engineRun("pdflatex"),
    ],
    cleanable: false,
  },
  {
    id: "single-pass",
    label: "xelatex / pdflatex / lualatex ×1",
    group: "debug",
    engine: null,
    // 工具按这次解析出的引擎替换（%ENGINE%）；不改 .orbita/latex.json
    steps: [{ tool: "%ENGINE%", args: [...ENGINE_COMMON] }],
    cleanable: false,
  },
  {
    id: "latexmk-shell-escape",
    label: "latexmk · xelatex（--shell-escape）",
    group: "special",
    engine: "xelatex",
    // minted / pygments 这类要在编译时起外部程序的包必须带这一旗标
    steps: [latexmk("-xelatex", "-shell-escape")],
    cleanable: true,
  },
];

/** 按 id 取预设；未知 id 回 null（旧配置里删掉的 id 不该让编译变成另一条链） */
export function latexRecipePreset(id: string | undefined | null): LatexRecipePreset | null {
  if (id === undefined || id === null || id === "") return null;
  return LATEX_RECIPE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * `%ENGINE%` 的工具名：契约里的 "pdf" 是 pdflatex 车道，可执行文件叫 pdflatex。
 * 与 latex-workbench.ts 的 engineLabel 同义，但那一份在 renderer，主进程不能读。
 */
export function latexEngineTool(engine: LatexEngine): string {
  return engine === "pdf" ? "pdflatex" : engine;
}
