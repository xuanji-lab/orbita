/**
 * 内置论文模板 —— `new_paper` 工具写进目标目录的那三份文件。
 *
 * **为什么内联成 TS 常量，而不是 assets/ 资源目录**：
 *   1. 总量不到 200 行（main.tex 约 70 行、refs.bib 约 35 行、占位图 781 字节的
 *      base64）。走资源目录要在 `build.extraResources` 里登记，还要为 dev
 *      （vite 的 out/）与打包后（process.resourcesPath）各写一套路径解析；为一份
 *      一屏能读完的模板付两份路径分支，是拿一个长期维护点换几十行代码。
 *   2. 内联后 `node --test` 直接调 `paperTemplateFiles()` 就能拿到全部内容，
 *      测试不必先定位资源根，也不必 mock app.isPackaged。
 *   3. 模板本身就是「能编过的最小骨架」，改它就得跑一次真编译——常量与测试在
 *      同一个文件树里，改完立刻能验。
 *   真有第二份模板（中文 / 期刊格式）时再拆成资源目录：那时「一份资源」才成立。
 *
 * **不放 README**：仓里禁新增 markdown（AGENTS.md），而模板的用法只有一句
 * 「运行 compile_latex」，写在工具返回文案与这里就够了。文件自己的说明用注释
 * 写在 main.tex 顶部。
 *
 * **不含任何本机绝对路径**：图走 `figures/example.png` 相对路径，整个目录拷到
 * 另一台机器（甚至另一个操作系统）仍然能编。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 给模型看的默认标题；用户给了 title 就替掉 \title{} 的内容 */
export const PAPER_TEMPLATE_TITLE = "A Minimal Paper Template";

/** 模板里图的名字：figure 环境与占位图必须同一个，改一处就断 */
export const PAPER_TEMPLATE_FIGURE = "figures/example.png";

export interface PaperTemplateFile {
  /** **相对项目目录**的 POSIX 风格路径（写盘时再按平台拆开） */
  path: string;
  content: string | Buffer;
}

/**
 * 320×160 的占位折线图（781 字节，PNG 8-bit RGB）。
 * 由脚本画出，不是下载的图——模板不该带别人的版权。
 */
const FIGURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAACgCAIAAADywSLLAAAC1ElEQVR42u3dwU3EMBCG0ZzohMqgBCSKoEJqoIgFcVoJsYg468w/fp9cgBXraZxcsl0kxbZ5BBLAkgCWBLAEsCSAJQEsCWAJYEkASwJYAlgSwJIAlgSwBPCEnl/enIQEsAQwwBLAAEsASwJYAhhgCWCAJYAlgAGWAAZYAlgSwBLAAEsAAywBLAlgCWCAJYABlgCWAAZYAhhgCWBJAEsAAywBDLAEsCSAJYABlgD+Bny9nIpkAksAAywBDLAEsNSzx6eP6wWwlCR2B12ApTyxAEtnovUOLK0rFmApWCzAUrBYgKVRseeiBVhKFQuwVP1iDLDUZ8wCLGKbiAVYxPYJYBELMMAiFmCJWIBFLMAAi1iAAdYOt54JwIIWYIDFLcAAc8stwIK2Z++vD9cLYHGbJHYH3VqA/RuJW2JdoQVtdbTegcXtumIBFrfBYgEWtMFiARa3o2LPRQuwuE0VC7D+cAttZbEAy7wNG7MAa3W3bcQCzO0SbruKBZhbYgEGOI0usQADzC2xAAPMLbEAq59bYgHmtgNaRwwwt9ACDHA9t6F0iQWYW2NWAHMLLcAAc+tuDDDAeZ+mjFmAVwccN2+hBXh1wA3QAgPwcoCD3BqzAAMMrQCGdiJXYgFeFPBPtNXcEgvwDMBZPzcrixZXgE3gJLTEAgxwElpiBXCMW1wFcBJaYgVwDFpcBfCQ2Jluf+NKrAAuJ5ZVAXwYWqNVABcFPFksrgJ4CPBMsawK4FHAc8QarQL4GMD3/vh0wyquAvjfgO8h9rZSVgXwAY2LpVQAl34HplQKAOzSK4UBplTqf4WWBLAEMMASwABLAEsAAywB3A+wvdkbwA7b3uwNYHuzN4ABtjd7A/jgB2pZ1o5/g20XSSawJIAlASwBLAlgSQBLAlgCWBLAkgCWAJYEsCSAJQEsASwJYEkASwJYAlgSwJIAlgSwJIAlgCUBLAEsCWBJAEv66hPdYiBmCIK5KAAAAABJRU5ErkJggg==";

/**
 * LaTeX 特殊字符转义。title 来自模型/用户，直接塞进 `\title{}` 会让一个 `%`
 * 注释掉整行、一个 `_` 直接编译失败。只处理能出现在标题里的那几个：
 * 反斜杠先替成占位符，免得后面补的 `\textasciitilde{}` 自己被再转义一遍。
 */
export function escapeLatexText(value: string): string {
  return value
    .replaceAll("\\", "\u0000")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replaceAll("~", "\\textasciitilde{}")
    .replaceAll("^", "\\textasciicircum{}")
    .replaceAll("\u0000", "\\textbackslash{}");
}

/** 标题只取第一行：`\title{}` 里塞换行会把模板排版搞乱，且通常不是本意 */
function normalizedTitle(title: string | undefined): string {
  const trimmed = (title ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  return trimmed === "" ? PAPER_TEMPLATE_TITLE : trimmed;
}

function mainTex(title: string): string {
  return `% Minimal paper template — written by Orbita's new_paper tool.
% Build it with latexmk (the compile_latex tool does this); the PDF lands in build/.
% Keep figures/ relative so the project can be copied to another machine as is.
\\documentclass[11pt]{article}

\\usepackage[margin=1in]{geometry}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{amsmath}
\\usepackage{natbib}
\\usepackage[hidelinks]{hyperref}

\\title{${escapeLatexText(title)}}
\\author{Your Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
This document is a minimal starting point for a paper: two sections, one figure,
one table, one equation, and a bibliography. Replace the placeholders with your
own work and keep the structure if it helps.
\\end{abstract}

\\section{Introduction}
Retrieval-augmented generation pairs a parametric language model with a
non-parametric index and conditions generation on retrieved passages
\\citep{lewis2020rag}. Dense retrieval makes that index trainable end to end
\\citep{karpukhin2020dpr}, while the underlying sequence model is the transformer
of \\citet{vaswani2017attention}.

\\section{Method}
We combine a dense retriever with a frozen generator. Given a question $q$ and a
set of retrieved passages $P$, the model estimates
$$
p(y \\mid q) = \\prod_{t=1}^{|y|} p\\bigl(y_t \\mid y_{<t}, q, P\\bigr),
$$
where $y$ is the answer sequence. Table~\\ref{tab:results} reports the setup and
Figure~\\ref{fig:overview} sketches the pipeline.

\\begin{figure}[t]
  \\centering
  \\includegraphics[width=0.7\\linewidth]{${PAPER_TEMPLATE_FIGURE}}
  \\caption{Placeholder figure. Replace \\texttt{${PAPER_TEMPLATE_FIGURE}} with
  your own plot (PNG or PDF) and keep the relative path.}
  \\label{fig:overview}
\\end{figure}

\\begin{table}[t]
  \\centering
  \\caption{Placeholder results. Replace the numbers with your own.}
  \\label{tab:results}
  \\begin{tabular}{lcc}
    \\toprule
    Method & Exact match & F1 \\\\
    \\midrule
    Baseline     & 31.2 & 42.8 \\\\
    + retrieval  & 38.4 & 50.1 \\\\
    + reranking  & 40.1 & 52.6 \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}

\\bibliographystyle{plainnat}
\\bibliography{refs}

\\end{document}
`;
}

const REFS_BIB = `% Three real, citable entries — replace them with the papers you actually build on.
@inproceedings{lewis2020rag,
  title     = {Retrieval-Augmented Generation for Knowledge-Intensive {NLP} Tasks},
  author    = {Lewis, Patrick and Perez, Ethan and Piktus, Aleksandra and Petroni, Fabio
               and Karpukhin, Vladimir and Goyal, Naman and K{\\"u}ttler, Heinrich
               and Lewis, Mike and Yih, Wen-tau and Rockt{\\"a}schel, Tim
               and Riedel, Sebastian and Kiela, Douwe},
  booktitle = {Advances in Neural Information Processing Systems},
  volume    = {33},
  pages     = {9459--9474},
  year      = {2020}
}

@inproceedings{karpukhin2020dpr,
  title     = {Dense Passage Retrieval for Open-Domain Question Answering},
  author    = {Karpukhin, Vladimir and O{\\u{g}}uz, Barlas and Min, Sewon and Lewis, Patrick
               and Wu, Ledell and Edunov, Sergey and Chen, Danqi and Yih, Wen-tau},
  booktitle = {Proceedings of the 2020 Conference on Empirical Methods in Natural Language Processing (EMNLP)},
  pages     = {6769--6781},
  year      = {2020}
}

@inproceedings{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob
               and Jones, Llion and Gomez, Aidan N. and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  booktitle = {Advances in Neural Information Processing Systems},
  volume    = {30},
  pages     = {5998--6008},
  year      = {2017}
}
`;

/**
 * 模板的完整文件清单。`title` 缺席 = PAPER_TEMPLATE_TITLE。
 * 内容是**函数产出**而不是导出常量：标题要转义、图名只该有一个出处。
 */
export function paperTemplateFiles(title?: string): PaperTemplateFile[] {
  return [
    { path: "main.tex", content: mainTex(normalizedTitle(title)) },
    { path: "refs.bib", content: REFS_BIB },
    { path: PAPER_TEMPLATE_FIGURE, content: Buffer.from(FIGURE_PNG_BASE64, "base64") },
  ];
}

/**
 * 把模板写进 `dir`（**调用方保证 dir 已存在**：空目录校验与授权都在
 * new-paper.ts，这一层只管落盘）。返回写出的相对路径清单。
 *
 * 父目录按需建（`figures/`）。这里不做原子写：这些是用户的项目源文件，不是
 * 配置/会话元数据；半途失败时 new-paper 会把已写的文件报给模型，重试即可。
 */
export function writePaperTemplate(dir: string, title?: string): string[] {
  const files = paperTemplateFiles(title);
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return files.map((file) => file.path);
}
