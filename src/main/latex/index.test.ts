/**
 * 项目索引的账：注释剔除、符号抽取、重复 label、路径候选、上限截断。
 * 夹具用真实论文里会出现的写法（`\newcommand{\R}{\mathbb{R}}`、被注释掉的 label、
 * `\label{#1}` 宏体占位符），不是编造的占位串。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildLatexIndex, extractSymbols, stripTexComments } from "./index.ts";

describe("stripTexComments", () => {
  test("去掉未转义的 % 到行尾，保留行数", () => {
    const text = "a % comment\nb \\% not\nc\nd";
    assert.equal(stripTexComments(text), "a \nb \\% not\nc\nd");
  });

  test("行尾的连续反斜杠是转义判定（\\\\% 的 % 仍是注释）", () => {
    assert.equal(stripTexComments("x \\\\ % gone\ny"), "x \\\\ \ny");
  });
});

describe("extractSymbols", () => {
  test("label 带行号，注释里的不进候选", () => {
    const text = ["\\section{A}", "\\label{sec:a}", "% \\label{sec:gone}", "text", "  \\label{eq:b}"].join("\n");
    assert.deepEqual(extractSymbols(text).labels, [
      { name: "sec:a", line: 2 },
      { name: "eq:b", line: 5 },
    ]);
  });

  test("宏定义体里的 \\label{#1} 不是真 label", () => {
    assert.deepEqual(extractSymbols("\\newcommand{\\alab}[1]{\\label{#1}}").labels, []);
  });

  test("命令：\\newcommand / \\renewcommand / \\def / \\DeclareMathOperator", () => {
    const text = [
      "\\newcommand{\\R}{\\mathbb{R}}",
      "\\renewcommand*\\vec[1]{\\mathbf{#1}}",
      "\\def\\eps{\\varepsilon}",
      "\\DeclareMathOperator*{\\argmax}{arg\\,max}",
    ].join("\n");
    assert.deepEqual(extractSymbols(text).commands.sort(), ["R", "argmax", "eps", "vec"]);
  });

  test("环境：\\newenvironment 与 \\newtheorem", () => {
    const text = "\\newenvironment{mybox}{\\begin{center}}{\\end{center}}\n\\newtheorem{lemma}{Lemma}[section]";
    assert.deepEqual(extractSymbols(text).environments.sort(), ["lemma", "mybox"]);
  });
});

describe("buildLatexIndex", () => {
  test("扫描项目目录：相对路径正斜杠、重复 label、路径候选含目录与图片", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbita-latex-index-"));
    try {
      mkdirSync(join(dir, "sections"));
      mkdirSync(join(dir, "figures"));
      writeFileSync(
        join(dir, "main.tex"),
        [
          "\\documentclass{article}",
          "\\begin{document}",
          "\\input{sections/intro}",
          "\\label{sec:intro}",
          "\\includegraphics{figures/plot.pdf}",
          "\\end{document}",
        ].join("\n"),
      );
      writeFileSync(join(dir, "sections", "intro.tex"), "\\section{Intro}\n\\label{sec:intro}\n\\label{sec:method}\n");
      writeFileSync(join(dir, "figures", "plot.pdf"), "%PDF-1.4\n");
      writeFileSync(join(dir, "refs.bib"), "@article{a, title={A}}\n");

      const index = buildLatexIndex(dir);
      assert.equal(index.dir, resolve(dir));
      assert.deepEqual(
        index.labels.map((label) => `${label.file}:${label.line}:${label.name}`),
        ["main.tex:4:sec:intro", "sections/intro.tex:2:sec:intro", "sections/intro.tex:3:sec:method"],
      );
      assert.deepEqual(index.duplicateLabels, ["sec:intro"]);
      assert.ok(index.files.includes("sections/"));
      assert.ok(index.files.includes("figures/plot.pdf"));
      assert.ok(index.files.includes("refs.bib"));
      assert.ok(index.files.includes("main.tex"));
      assert.equal(index.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("空目录不抛错、返回空索引", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbita-latex-index-empty-"));
    try {
      const index = buildLatexIndex(dir);
      assert.deepEqual(index.labels, []);
      assert.deepEqual(index.files, []);
      assert.deepEqual(index.duplicateLabels, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
