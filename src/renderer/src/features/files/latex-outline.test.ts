/**
 * 折叠与大纲的账：章节块 / 环境块的折叠区间、章节树解析、光标落在第几节。
 * 夹具用真实论文片段（`\section{…}\label{…}`、嵌套 itemize、被注释掉的标题）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { foldRangesFor } from "./latex-fold.ts";
import { outlineIndexAt, outlineTitle, parseOutline } from "./latex-outline.ts";

const doc = [
  "\\documentclass{article}", // 1
  "\\begin{document}", // 2
  "\\section{Intro}", // 3
  "\\label{sec:intro}", // 4
  "text", // 5
  "\\subsection{Background}", // 6
  "more", // 7
  "\\section{Method}", // 8
  "\\begin{itemize}", // 9
  "\\item one", // 10
  "\\end{itemize}", // 11
  "\\end{document}", // 12
].join("\n");

describe("foldRangesFor", () => {
  test("章节折到下一个同级标题之前；标题行保持可见", () => {
    const ranges = foldRangesFor(doc);
    const section = ranges.find((range) => range.startLineFrom === doc.indexOf("\\section{Intro}"));
    assert.ok(section !== undefined);
    assert.equal(section.from, doc.indexOf("\\section{Intro}\n") + "\\section{Intro}".length);
    assert.equal(section.to, doc.indexOf("\\section{Method}"));
  });

  test("章节折到 \\end{document} 之前（没有下一个标题时）", () => {
    const ranges = foldRangesFor(doc);
    const method = ranges.find((range) => range.startLineFrom === doc.indexOf("\\section{Method}"));
    assert.ok(method !== undefined);
    // Method 之后没有同级标题：折到 \end{document} 那一行的起点
    assert.equal(method.to, doc.indexOf("\\end{document}"));
  });

  test("环境折到 \\end 行之前；同一行的 begin/end 不折", () => {
    const ranges = foldRangesFor(doc);
    const itemize = ranges.find((range) => range.startLineFrom === doc.indexOf("\\begin{itemize}"));
    assert.ok(itemize !== undefined);
    assert.equal(itemize.to, doc.indexOf("\\end{itemize}"));
    assert.equal(foldRangesFor("\\begin{x}a\\end{x}").length, 0);
  });

  test("注释掉的标题不产生折点", () => {
    const ranges = foldRangesFor("% \\section{Fake}\ntext\n\\section{Real}\na");
    assert.equal(ranges.filter((range) => range.startLineFrom === 0).length, 0);
    assert.equal(ranges.length, 1);
  });

  test("同名环境嵌套：内层折到内层 end", () => {
    const text = "\\begin{a}\nx\n\\begin{a}\ny\n\\end{a}\nz\n\\end{a}";
    const ranges = foldRangesFor(text);
    const starts = ranges.map((range) => range.startLineFrom);
    assert.deepEqual(starts, [0, text.indexOf("\\begin{a}", 1)]);
    assert.equal(ranges[1]?.to, text.indexOf("\\end{a}"));
  });
});

describe("parseOutline", () => {
  test("章节树：层级按最浅一级归零，行号是 1 基", () => {
    assert.deepEqual(
      parseOutline(doc).map((entry) => `${entry.line}:${entry.level}:${entry.title}`),
      ["3:0:Intro", "6:1:Background", "8:0:Method"],
    );
  });

  test("星号标题、可选参数、跨行标题都认；注释里的不认", () => {
    const text = "% \\section{Gone}\n\\section*[short]{A \\textbf{bold} title}\n\\subsection{Multi\nline}";
    assert.deepEqual(
      parseOutline(text).map((entry) => `${entry.level}:${entry.title}`),
      ["0:A \\textbf{bold} title", "1:Multi line"],
    );
  });

  test("空标题退成命令名", () => {
    assert.equal(parseOutline("\\section{}")[0]?.title, "\\section");
  });

  test("outlineTitle 去掉 label 与 footnote", () => {
    assert.equal(outlineTitle("Results\\label{sec:r}\\footnote{x} here"), "Results here");
  });

  test("outlineIndexAt：光标前一节；第一节之前是 -1", () => {
    const entries = parseOutline(doc);
    assert.equal(outlineIndexAt(entries, 1), -1);
    assert.equal(outlineIndexAt(entries, 4), 0);
    assert.equal(outlineIndexAt(entries, 7), 1);
    assert.equal(outlineIndexAt(entries, 99), 2);
    assert.equal(outlineIndexAt([], 3), -1);
  });
});
