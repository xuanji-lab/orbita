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

/* ---------- 跨文件聚合（2026-11 多文件导航） ---------- */

import type { LatexNav } from "../../../../shared/latex.ts";
import { aggregateOutline, outlineView, parseSections } from "./latex-outline.ts";

/** 三份文件的导航载荷：main → ch1 → ch2，章节与 \input 交错在同一份源码里 */
const nav: LatexNav = {
  dir: "/proj",
  root: "main.tex",
  rootPath: "/proj/main.tex",
  focusRoots: ["main.tex"],
  truncated: false,
  limits: [],
  files: [
    {
      path: "/proj/main.tex",
      display: "main.tex",
      owners: [],
      roots: ["main.tex"],
      includes: [
        { command: "input", raw: "sections/ch1", line: 4, argFrom: 7, argTo: 19, target: "/proj/sections/ch1.tex" },
        { command: "input", raw: "sections/ch2", line: 5, argFrom: 7, argTo: 19, target: "/proj/sections/ch2.tex" },
        { command: "input", raw: "sections/missing", line: 6, argFrom: 7, argTo: 23, target: null },
      ],
      sections: [
        { command: "section", title: "Introduction", level: 2, line: 3 },
        { command: "section", title: "Conclusion", level: 2, line: 7 },
      ],
    },
    {
      path: "/proj/sections/ch1.tex",
      display: "sections/ch1.tex",
      owners: ["/proj/main.tex"],
      roots: ["main.tex"],
      includes: [],
      sections: [
        { command: "section", title: "Method", level: 2, line: 1 },
        { command: "subsection", title: "Detail", level: 3, line: 2 },
      ],
    },
    {
      path: "/proj/sections/ch2.tex",
      display: "sections/ch2.tex",
      owners: ["/proj/main.tex"],
      roots: ["main.tex"],
      includes: [],
      sections: [{ command: "section", title: "Results", level: 2, line: 1 }],
    },
  ],
};

describe("aggregateOutline", () => {
  test("顺序 = 展开后的文档顺序（章节与 \input 按行交错），每项带来源文件", () => {
    assert.deepEqual(
      aggregateOutline("/proj/main.tex", nav.files).map(
        (entry) => `${entry.display}:${entry.line}:${entry.level}:${entry.title}`,
      ),
      [
        "main.tex:3:0:Introduction",
        "sections/ch1.tex:1:0:Method",
        "sections/ch1.tex:2:1:Detail",
        "sections/ch2.tex:1:0:Results",
        "main.tex:7:0:Conclusion",
      ],
    );
  });

  test("unresolved 的 \input 不展开（也不吞掉后面的章节）", () => {
    const sources = nav.files.map((file) => ({
      path: file.path,
      display: file.display,
      sections: file.sections,
      includes: file.includes,
    }));
    const titles = aggregateOutline("/proj/main.tex", sources).map((entry) => entry.title);
    assert.equal(titles.includes("Conclusion"), true);
    assert.equal(titles.length, 5);
  });

  test("环：同一个文件不会在自己的子树里再展开", () => {
    const sources = [
      {
        path: "/p/a.tex",
        display: "a.tex",
        sections: [{ command: "section", title: "A", level: 2, line: 1 }],
        includes: [{ line: 2, target: "/p/b.tex" }],
      },
      {
        path: "/p/b.tex",
        display: "b.tex",
        sections: [{ command: "section", title: "B", level: 2, line: 1 }],
        includes: [{ line: 2, target: "/p/a.tex" }],
      },
    ];
    assert.deepEqual(aggregateOutline("/p/a.tex", sources).map((entry) => entry.title), ["A", "B"]);
  });
});

describe("outlineView", () => {
  test("当前文件的章节用编辑器里的活文本（刚改的标题不等轮询）", () => {
    const live = "\\section{Method (edited)}\n\\subsection{Detail}\n";
    const view = outlineView({ text: live, path: "/proj/sections/ch1.tex", nav });
    assert.equal(view.rootLabel, "main.tex");
    assert.deepEqual(view.entries.map((entry) => entry.title), [
      "Introduction",
      "Method (edited)",
      "Detail",
      "Results",
      "Conclusion",
    ]);
  });

  test("没有 root（或导航还没到）时退回只看当前文件", () => {
    const text = "\section{Solo}\n\subsection{Sub}\n";
    const fallback = outlineView({ text, path: "/proj/notes.tex", nav: null });
    assert.equal(fallback.rootLabel, null);
    assert.deepEqual(fallback.entries, parseOutline(text));
    assert.equal(fallback.entries.some((entry) => entry.file !== undefined), false);

    const noRoot = outlineView({ text, path: "/proj/notes.tex", nav: { ...nav, root: null, rootPath: null } });
    assert.deepEqual(noRoot.entries, parseOutline(text));
  });

  test("outlineIndexAt 传当前文件：别的文件的同名行号不参与高亮", () => {
    const entries = aggregateOutline("/proj/main.tex", nav.files);
    assert.equal(outlineIndexAt(entries, 4, "/proj/main.tex"), 0);
    assert.equal(outlineIndexAt(entries, 1, "/proj/sections/ch1.tex"), 1);
    assert.equal(outlineIndexAt(entries, 2, "/proj/sections/ch1.tex"), 2);
    // ch1 里没有超过第 2 行的条目：光标往下移不会跳到别的文件的节上
    assert.equal(outlineIndexAt(entries, 99, "/proj/sections/ch1.tex"), 2);
  });
});

describe("parseSections", () => {
  test("绝对层级（part=0 … subparagraph=6）：跨文件归一交给调用方", () => {
    assert.deepEqual(
      parseSections("\\part{P}\n\\chapter{C}\n\\section{S}\n\\paragraph{P2}").map((entry) => entry.level),
      [0, 1, 2, 5],
    );
  });
});
