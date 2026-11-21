/**
 * 「bib 里有、正文没引」的判定：引用命令的识别、闭包的边界、`\\nocite{*}` 的语义。
 * 闭包用真临时目录（includeClosure 读盘），不 mock。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiteLibrary } from "../../shared/cite.ts";
import { collectCiteLibrary } from "./library.ts";
import { extractCiteKeys, scanUnusedCitations, unusedCitations } from "./unused.ts";

const LF = String.fromCharCode(10);

function library(entries: CiteLibrary["entries"], files: string[] = ["refs.bib"]): CiteLibrary {
  return { entries, files: files.map((path) => ({ path, bad: 0, error: null })), skipped: [], truncated: false };
}

const entry = (key: string, line = 1) => ({
  key,
  type: "article",
  title: `Title ${key}`,
  author: null,
  year: "2020",
  doi: null,
  eprint: null,
  file: "refs.bib",
  line,
});

describe("extractCiteKeys —— 命令与参数", () => {
  test("常用命令、可选参数、多 key、注释里的不算", () => {
    const scan = extractCiteKeys(`
\\citep[see][p.~3]{a, b}
\\citet{c}
% \\cite{ghost}
\\textcite{d}
\\parencite{e}
`);
    assert.deepEqual([...scan.keys].sort(), ["a", "b", "c", "d", "e"]);
    assert.equal(scan.nociteAll, false);
  });

  test("biblatex 的 \\cites{a}{b} 两组都收", () => {
    const scan = extractCiteKeys("\\cites[see]{a}[p.~2]{b}");
    assert.deepEqual([...scan.keys].sort(), ["a", "b"]);
  });

  test("\\nocite{*} 单独标记为「全部引用」，不产生键", () => {
    const scan = extractCiteKeys("\\nocite{*}");
    assert.equal(scan.nociteAll, true);
    assert.equal(scan.keys.size, 0);
  });

  test("宏定义体里的占位符 #1 不是引用键", () => {
    const scan = extractCiteKeys("\\newcommand{\\mycite}[1]{\\cite{#1}}");
    assert.equal(scan.keys.size, 0);
  });
});

describe("unusedCitations —— 判定", () => {
  test("多条引用、同一 key 多次：只留下一次都没引的", () => {
    const report = unusedCitations(library([entry("a"), entry("b"), entry("c")]), [
      "\\cite{a} and \\citep{a,b}",
    ], { rootFound: true, truncated: false });
    assert.deepEqual(report.entries.map((item) => item.key), ["c"]);
    assert.equal(report.bibFiles, 1);
  });

  test("bib 里没有的 key 是「未定义」，不是「未使用」——不进清单", () => {
    const report = unusedCitations(library([entry("a")]), ["\\cite{ghost,a}"], {
      rootFound: true,
      truncated: false,
    });
    assert.deepEqual(report.entries, []);
  });

  test("\\nocite{*} 视为全部引用：清单为空并带原因", () => {
    const report = unusedCitations(library([entry("a"), entry("b")]), ["\\nocite{*}"], {
      rootFound: true,
      truncated: false,
    });
    assert.deepEqual(report.entries, []);
    assert.equal(report.nociteAll, true);
  });

  test("没有 root / 文献库截断：如实反映", () => {
    const noRoot = unusedCitations(library([entry("a")]), [], { rootFound: false, truncated: false });
    assert.deepEqual(noRoot.entries, []);
    assert.equal(noRoot.rootFound, false);

    const truncatedLibrary = { ...library([entry("a")]), truncated: true };
    const report = unusedCitations(truncatedLibrary, ["\\cite{b}"], { rootFound: true, truncated: false });
    assert.equal(report.truncated, true);
    assert.deepEqual(report.entries.map((item) => item.key), ["a"]);
  });
});

describe("scanUnusedCitations —— 只认当前 root 的包含闭包", () => {
  test("\\input 进来的子文件算，项目里没被包含的 .tex 不算", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-unused-"));
    try {
      await writeFile(join(dir, "main.tex"), [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\cite{alpha}",
        "\\input{sections/ch1}",
        "\\bibliography{refs}",
        "\\end{document}",
      ].join(LF));
      await mkdir(join(dir, "sections"));
      await writeFile(join(dir, "sections/ch1.tex"), "\\citep{beta,missing}");
      // 没被 main.tex 包含：它引的 gamma 不该让 gamma 变成「已引用」
      await writeFile(join(dir, "appendix.tex"), "\\cite{gamma}");
      await writeFile(join(dir, "refs.bib"), [
        "@article{alpha, title = {A}, year = {2020}}",
        "@article{beta, title = {B}, year = {2021}}",
        "@article{gamma, title = {C}, year = {2022}}",
      ].join(LF));

      const report = scanUnusedCitations(join(dir, "main.tex"), collectCiteLibrary(dir));
      assert.equal(report.rootFound, true);
      assert.equal(report.texFiles, 2);
      assert.deepEqual(report.entries.map((item) => item.key), ["gamma"]);
      assert.equal(report.entries[0]?.line, 3);
      assert.equal(report.entries[0]?.file, "refs.bib");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("闭包里的 \\nocite{*} 让整份清单为空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-unused-nocite-"));
    try {
      await writeFile(join(dir, "main.tex"), [
        "\\documentclass{article}",
        "\\nocite{*}",
        "\\bibliography{refs}",
      ].join(LF));
      await writeFile(join(dir, "refs.bib"), "@book{a, title = {A}}");
      const report = scanUnusedCitations(join(dir, "main.tex"), collectCiteLibrary(dir));
      assert.equal(report.nociteAll, true);
      assert.deepEqual(report.entries, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("root 读不到：rootFound=false，不报错", () => {
    const report = scanUnusedCitations(join(tmpdir(), "orbita-no-such-root.tex"), library([entry("a")]));
    assert.equal(report.rootFound, false);
    assert.deepEqual(report.entries, []);
  });
});
