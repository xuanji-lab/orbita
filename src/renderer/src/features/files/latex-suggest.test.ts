/**
 * 补全纯逻辑的账：五个现场（命令 / 环境 / 引用 / 路径 / snippet）的识别与候选。
 * 夹具是写论文时真会出现的片段（`\citep[see][p.~3]{`、`\includegraphics[width=…]{fig/`），
 * 不是编造的占位串。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LatexProjectIndex } from "../../../../shared/latex.ts";
import { environmentInsertion, latexContextBefore, loadedPackageNames, suggestLatex, type LatexSuggestTexts } from "./latex-suggest.ts";

/**
 * 候选行的说明文字。补全逻辑是纯函数，文案由调用方传（生产里是 `t.latexSuggest`）；
 * 这里用中文那几个词，断言才能一眼看出「detail 是文案、不是写死的常量」。
 */
const TEXTS: LatexSuggestTexts = {
  loaded: "已加载",
  projectDefined: "本项目定义",
  dupLabel: " · 同名 label 出现多次",
  dupLabelInfo: (file, line) => `多处定义，引用编号可能指错：${file}:${line}`,
  directory: "目录",
};

const emptyIndex: LatexProjectIndex = {
  dir: "/paper",
  labels: [],
  duplicateLabels: [],
  commands: [],
  environments: [],
  files: [],
  truncated: false,
};

const projectIndex: LatexProjectIndex = {
  dir: "/paper",
  labels: [
    { name: "sec:intro", file: "main.tex", line: 12 },
    { name: "eq:loss", file: "sections/method.tex", line: 40 },
    { name: "sec:intro", file: "sections/intro.tex", line: 3 },
  ],
  duplicateLabels: ["sec:intro"],
  commands: ["R", "argmax"],
  environments: ["mybox"],
  files: ["main.tex", "sections/", "sections/method.tex", "figures/", "figures/plot.pdf", "refs.bib"],
  truncated: false,
};

describe("latexContextBefore", () => {
  test("命令：`\\fra` 的替换区间从反斜杠之后算起", () => {
    const context = latexContextBefore("text \\fra");
    assert.deepEqual(context, { kind: "command", from: 6, query: "fra" });
  });

  test("命令：`\\\\frac` 是换行后的文字，不是命令现场", () => {
    assert.equal(latexContextBefore("text \\\\frac"), null);
  });

  test("环境：\\begin{ 与 \\end{ 分开，query 从花括号之后算", () => {
    assert.deepEqual(latexContextBefore("\\begin{equ"), { kind: "environment", from: 7, query: "equ", mode: "begin" });
    assert.deepEqual(latexContextBefore("\\end{item"), { kind: "environment", from: 5, query: "item", mode: "end" });
  });

  test("引用：\\ref / \\eqref / \\cref 都认，替换区间在 { 之后", () => {
    assert.deepEqual(latexContextBefore("\\ref{sec:"), { kind: "reference", from: 5, query: "sec:" });
    assert.deepEqual(latexContextBefore("\\eqref{eq:"), { kind: "reference", from: 7, query: "eq:" });
    assert.deepEqual(latexContextBefore("\\cref{fig:"), { kind: "reference", from: 6, query: "fig:" });
  });

  test("路径：\\input 与 \\includegraphics 的可选参数都跳过", () => {
    assert.deepEqual(latexContextBefore("\\input{sec"), { kind: "path", from: 7, query: "sec", mode: "tex" });
    assert.deepEqual(latexContextBefore("\\includegraphics[width=0.8\\textwidth]{fig/"), {
      kind: "path",
      from: 38,
      query: "fig/",
      mode: "graphics",
    });
  });

  test("注释里的现场不弹；\\% 是字面百分号，后面的 \\ref 仍是现场", () => {
    assert.equal(latexContextBefore("% \\ref{sec"), null);
    assert.deepEqual(latexContextBefore("\\% \\ref{sec"), { kind: "reference", from: 8, query: "sec" });
  });

  test("\\cite 的现场交给文献库（不在这里返回命令 / 引用）", () => {
    assert.equal(latexContextBefore("\\citep[see][p.~3]{doe"), null);
  });

  test("snippet：大写缩写与带符号的前缀才触发", () => {
    assert.deepEqual(latexContextBefore("BEQ"), { kind: "snippet", from: 0, query: "BEQ" });
    assert.deepEqual(latexContextBefore("x __"), { kind: "snippet", from: 2, query: "__" });
    // 普通英文单词（item 是 LaTeX snippet 的前缀，但也是正文里的词）
    assert.equal(latexContextBefore("the item"), null);
  });
});

describe("suggestLatex", () => {
  test("命令：前缀命中排在包含命中之前，项目自定义命令也进候选", () => {
    const context = latexContextBefore("\\sec");
    assert.ok(context !== null);
    const names = suggestLatex(context, projectIndex, TEXTS).map((row) => row.label);
    assert.ok(names.includes("section"));
    assert.ok(names.includes("section*"));
    const projectCommand = suggestLatex({ kind: "command", from: 1, query: "argm" }, projectIndex, TEXTS);
    assert.equal(projectCommand[0]?.label, "argmax");
    assert.equal(projectCommand[0]?.detail, "本项目定义");
    assert.equal(projectCommand[0]?.insert, "snippet");
  });

  test("命令：空查询先给常用命令（\\section 在最前）", () => {
    const rows = suggestLatex({ kind: "command", from: 1, query: "" }, emptyIndex, TEXTS);
    assert.equal(rows[0]?.label, "section");
    assert.ok(rows.length > 10);
  });

  test("命令候选的 snippet 里不能留 VS Code 的 $N 语法", () => {
    const rows = suggestLatex({ kind: "command", from: 1, query: "frac" }, emptyIndex, TEXTS);
    const frac = rows.find((row) => row.label === "frac");
    assert.ok(frac !== undefined);
    assert.ok(!/\$\d/.test(frac.text), `snippet 仍是 ${frac.text}`);
  });

  test("环境：begin 插入配对 end，end 只补名字", () => {
    const begin = suggestLatex({ kind: "environment", from: 7, query: "item", mode: "begin" }, emptyIndex, TEXTS);
    const itemize = begin.find((row) => row.label === "itemize");
    assert.ok(itemize !== undefined);
    assert.ok(itemize.text.includes("\\end{itemize}"));
    assert.ok(itemize.text.includes("\\item"));
    const end = suggestLatex({ kind: "environment", from: 5, query: "item", mode: "end" }, emptyIndex, TEXTS);
    assert.equal(end.find((row) => row.label === "itemize")?.text, "itemize}");
  });

  test("环境：项目自定义的环境补在静态表后面", () => {
    const rows = suggestLatex({ kind: "environment", from: 7, query: "my", mode: "begin" }, projectIndex, TEXTS);
    assert.equal(rows[0]?.label, "mybox");
    assert.equal(rows[0]?.detail, "本项目定义");
  });

  test("引用：label 来自索引，detail 是 文件:行，重名的标出来", () => {
    const rows = suggestLatex({ kind: "reference", from: 5, query: "sec:" }, projectIndex, TEXTS);
    assert.deepEqual(rows.map((row) => row.label), ["sec:intro", "sec:intro"]);
    assert.equal(rows[0]?.detail, "main.tex:12 · 同名 label 出现多次");
    assert.equal(rows[0]?.text, "sec:intro}");
  });

  test("路径：图片模式只给图片（与目录），tex 模式只给 .tex", () => {
    const graphics = suggestLatex({ kind: "path", from: 20, query: "fig", mode: "graphics" }, projectIndex, TEXTS);
    assert.deepEqual(graphics.map((row) => row.label), ["figures/", "figures/plot.pdf"]);
    const tex = suggestLatex({ kind: "path", from: 7, query: "sec", mode: "tex" }, projectIndex, TEXTS);
    assert.deepEqual(tex.map((row) => row.label), ["sections/", "sections/method.tex"]);
    const bib = suggestLatex({ kind: "path", from: 12, query: "ref", mode: "bib" }, projectIndex, TEXTS);
    assert.deepEqual(bib.map((row) => row.label), ["refs.bib"]);
  });

  test("路径：索引缺席时没有候选（不猜盘上有什么）", () => {
    assert.deepEqual(suggestLatex({ kind: "path", from: 7, query: "sec", mode: "tex" }, null, TEXTS), []);
  });

  test("snippet：BEQ 给出完整的 equation 环境", () => {
    const rows = suggestLatex({ kind: "snippet", from: 0, query: "BEQ" }, emptyIndex, TEXTS);
    assert.equal(rows[0]?.label, "BEQ");
    assert.ok(rows[0]?.text.includes("\\begin{equation}"));
  });
});

describe("environmentInsertion", () => {
  test("begin 模式把环境名补上右括号再接 body 与 \\end", () => {
    assert.equal(environmentInsertion("begin", "figure", "\n\t${0}"), "figure}\n\t${0}\n\\end{figure}");
    assert.equal(environmentInsertion("end", "figure", "\n\t${0}"), "figure}");
  });
});

describe("宏包补全（usepackage）", () => {
  test("现场：不带选项、带选项、多个包名（替换区间跳过前面的名字）", () => {
    assert.deepEqual(latexContextBefore(String.raw`\usepackage{ams`), { kind: "package", from: 12, query: "ams" });
    assert.deepEqual(latexContextBefore(String.raw`\usepackage[utf8]{ams`), {
      kind: "package",
      from: 18,
      query: "ams",
    });
    assert.deepEqual(latexContextBefore(String.raw`\usepackage{amsmath,geom`), {
      kind: "package",
      from: 20,
      query: "geom",
    });
    assert.deepEqual(latexContextBefore(String.raw`\RequirePackage{x`), { kind: "package", from: 16, query: "x" });
  });

  test("注释里的 usepackage 不弹", () => {
    assert.equal(latexContextBefore(String.raw`% \usepackage{ams`), null);
  });

  test("本机名单：前缀过滤、按名字序；已加载的排在前面并标注", () => {
    const rows = suggestLatex({ kind: "package", from: 0, query: "am" }, emptyIndex, TEXTS, 60, {
      installed: ["amsfonts", "amsmath", "booktabs"],
      loaded: ["amsmath", "geometry"],
    });
    assert.deepEqual(rows.map((row) => row.label), ["amsmath", "amsfonts"]);
    assert.equal(rows[0]?.detail, "已加载");
    assert.equal(rows[1]?.detail, null);
    assert.equal(rows[0]?.insert, "plain");
    assert.equal(rows[0]?.text, "amsmath");
  });

  test("没有 TeX（installed 为空）时退回「只补已加载的」", () => {
    const rows = suggestLatex({ kind: "package", from: 0, query: "" }, emptyIndex, TEXTS, 60, {
      installed: [],
      loaded: ["geometry", "hyperref"],
    });
    assert.deepEqual(rows.map((row) => row.label), ["geometry", "hyperref"]);
    assert.deepEqual(
      suggestLatex({ kind: "package", from: 0, query: "" }, emptyIndex, TEXTS, 60, { installed: [], loaded: [] }),
      [],
    );
  });

  test("loadedPackageNames：拆逗号、去重、跳过注释", () => {
    const text = [
      String.raw`\documentclass{article}`,
      String.raw`\usepackage{amsmath,geometry}`,
      String.raw`% \usepackage{comment}`,
      String.raw`\usepackage[utf8]{inputenc}`,
      String.raw`\usepackage{amsmath}`,
    ].join("\n");
    assert.deepEqual(loadedPackageNames(text), ["amsmath", "geometry", "inputenc"]);
  });
});
