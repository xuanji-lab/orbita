/**
 * pandoc argv：格式、模板、目录 / 图目录 / 表目录、citeproc，以及最要紧的一条
 * ——**永远不传 `--number-sections`**。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPandocArgs, detectInputFormat, latexTableEnvironments } from "./argv.ts";

const base = { sourcePath: "/work/paper.md", outPath: "/work/paper.docx", referenceDoc: null };

describe("输入格式", () => {
  test("只认 .md / .markdown / .tex", () => {
    assert.equal(detectInputFormat("/a/b.md"), "markdown");
    assert.equal(detectInputFormat("/a/b.MARKDOWN"), "markdown");
    assert.equal(detectInputFormat("/a/b.tex"), "latex");
    assert.equal(detectInputFormat("/a/b.txt"), null);
    assert.equal(detectInputFormat("/a/b"), null);
  });
});

describe("argv 拼装", () => {
  test("markdown：gfm + docx + 输出 + 资源根", () => {
    const plan = buildPandocArgs({ ...base, format: "markdown", text: "hello" });
    assert.equal(plan.from, "gfm");
    assert.deepEqual(plan.args.slice(0, 6), ["--from", "gfm", "--to", "docx", "--output", "/work/paper.docx"]);
    assert.ok(plan.args.includes("--resource-path=/work"));
    assert.equal(plan.args[plan.args.length - 1], "/work/paper.md");
    assert.equal(plan.args.filter((arg) => arg === "--number-sections").length, 0);
  });

  test("latex：latex 读取器；目录三节总是先要（空节由后处理裁）", () => {
    const text = "\\section{Intro}\n\\begin{equation}a=b\\end{equation}";
    const plan = buildPandocArgs({ ...base, sourcePath: "/work/paper.tex", format: "latex", text });
    assert.equal(plan.from, "latex");
    assert.ok(plan.args.includes("--toc"));
    assert.ok(plan.args.includes("--lof"));
    assert.ok(plan.args.includes("--lot"));
    assert.ok(!plan.args.includes("--number-sections"));
  });

  test("目录三节一律先让 pandoc 生成；有没有内容由 pruneEmptyLists 按产物裁", () => {
    const none = buildPandocArgs({ ...base, format: "markdown", text: "just text" });
    assert.ok(none.args.includes("--toc") && none.args.includes("--lof") && none.args.includes("--lot"));
  });

  test("LaTeX 表格环境识别（tabular / tabularx / longtable）", () => {
    assert.deepEqual(latexTableEnvironments("\\begin{tabular}{lc}a&b\\end{tabular}"), ["tabular"]);
    assert.deepEqual(latexTableEnvironments("\\begin{tabularx}{\\linewidth}{lc}a&b\\end{tabularx}"), ["tabularx"]);
    assert.deepEqual(latexTableEnvironments("\\begin{longtable}{lc}a&b\\end{longtable}"), ["longtable"]);
    assert.deepEqual(latexTableEnvironments("文本只有 \\begin{table} 包着图"), []);
    assert.deepEqual(latexTableEnvironments("# markdown 表格\n| a | b |\n|---|---|"), []);
  });

  test("引用：markdown @key / latex \\cite 才加 --citeproc", () => {
    assert.equal(buildPandocArgs({ ...base, format: "markdown", text: "see @lewis2020" }).citeproc, true);
    assert.equal(buildPandocArgs({ ...base, format: "markdown", text: "no cites" }).citeproc, false);
    assert.equal(
      buildPandocArgs({ ...base, sourcePath: "/w/p.tex", format: "latex", text: "\\citep{k}" }).citeproc,
      true,
    );
  });

  test("reference-doc 给了才传；不留裸 --number-sections", () => {
    const plan = buildPandocArgs({ ...base, format: "markdown", text: "# H", referenceDoc: "C:\\t\\school.docx" });
    assert.ok(plan.args.includes("--reference-doc=C:\\t\\school.docx"));
    assert.equal(plan.args.some((arg) => arg.startsWith("--number-sections")), false);
  });

  test("资源根取源文件的目录（相对图片 / .bib 才解析得到）", () => {
    const plan = buildPandocArgs({ ...base, sourcePath: "C:\\work\\sub\\paper.md", format: "markdown", text: "" });
    assert.ok(plan.args.includes("--resource-path=C:\\work\\sub"));
  });
});
