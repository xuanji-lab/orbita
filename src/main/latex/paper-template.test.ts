/**
 * 论文模板：内容契约 + **真验收**（本机有 latexmk 时真的编一遍）。
 *
 * 为什么这里要跑真 latexmk：模板的价值只有一个——拿到就能编过。排版类的东西
 * 用假货测不出来（少一个包、\\cite 的 key 对不上 refs.bib、图的路径写错，都要
 * 真引擎才会报）。机器没装 TeX Live 时 **skip 而不是 fail**：CI 与 contributor
 * 的机器不一定有 LaTeX，而「没装」不是这个 PR 的缺陷（与 probe 的 not-installed
 * 同一口径）。
 *
 * 编译用的就是 PR1 的 LatexRunner，不另写一套 spawn：模板要证明的正是「我们给的
 * 骨架在正式编译路径上是通的」。
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAPER_TEMPLATE_FIGURE,
  PAPER_TEMPLATE_TITLE,
  escapeLatexText,
  paperTemplateFiles,
  writePaperTemplate,
} from "./paper-template.ts";
import { createLatexProbe } from "./probe.ts";
import { LatexRunner } from "./run.ts";

const roots: string[] = [];

function temp(prefix = "orbita-paper-template-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fileContent(path: string): string {
  const file = paperTemplateFiles().find((item) => item.path === path);
  assert.ok(file !== undefined, `模板里没有 ${path}`);
  return typeof file.content === "string" ? file.content : file.content.toString("utf8");
}

describe("模板内容", () => {
  test("三份文件，路径都是相对 POSIX 形式", () => {
    assert.deepEqual(
      paperTemplateFiles().map((file) => file.path),
      ["main.tex", "refs.bib", PAPER_TEMPLATE_FIGURE],
    );
  });

  test("main.tex 带齐必需宏包与全部演示元素", () => {
    const tex = fileContent("main.tex");
    for (const pkg of [
      "\\documentclass[11pt]{article}",
      "\\usepackage[margin=1in]{geometry}",
      "\\usepackage{graphicx}",
      "\\usepackage{booktabs}",
      "\\usepackage{amsmath}",
      "\\usepackage{natbib}",
      "\\usepackage[hidelinks]{hyperref}",
    ]) {
      assert.ok(tex.includes(pkg), `缺 ${pkg}`);
    }
    assert.match(tex, /\\begin\{abstract\}/);
    assert.equal((tex.match(/\\section\{/g) ?? []).length, 2);
    assert.match(tex, /\\begin\{figure\}/);
    assert.ok(tex.includes(`\\includegraphics[width=0.7\\linewidth]{${PAPER_TEMPLATE_FIGURE}}`));
    assert.match(tex, /\\begin\{table\}/);
    assert.match(tex, /\\toprule/);
    assert.match(tex, /\\citep\{lewis2020rag\}/);
    assert.match(tex, /\$\$\n[\s\S]*\n\$\$/);
    // 模板不许带本机绝对路径：拷到别的机器还得能编
    assert.doesNotMatch(tex, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(tex, /\/Users\/|\/home\//);
  });

  test("refs.bib 三条，key 与正文引用一一对应", () => {
    const bib = fileContent("refs.bib");
    const keys = [...bib.matchAll(/^@\w+\{([^,]+),/gm)].map((match) => match[1]);
    assert.deepEqual(keys, ["lewis2020rag", "karpukhin2020dpr", "vaswani2017attention"]);
    const tex = fileContent("main.tex");
    for (const key of keys) assert.ok(tex.includes(key), `正文没引用 ${key}`);
  });

  test("占位图是合法 PNG（签名 + IHDR）", () => {
    const file = paperTemplateFiles().find((item) => item.path === PAPER_TEMPLATE_FIGURE);
    assert.ok(file !== undefined);
    const png = file.content as Buffer;
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  });

  test("title 缺省与自定义：替换 \\title{} 并对特殊字符转义", () => {
    const plain = paperTemplateFiles().find((file) => file.path === "main.tex");
    assert.ok(plain !== undefined && typeof plain.content === "string");
    assert.ok(plain.content.includes(`\\title{${PAPER_TEMPLATE_TITLE}}`));

    const custom = paperTemplateFiles("A 50%_test & more").find((file) => file.path === "main.tex");
    assert.ok(custom !== undefined && typeof custom.content === "string");
    assert.ok(custom.content.includes("\\title{A 50\\%\\_test \\& more}"));
  });

  test("escapeLatexText：反斜杠只转一次，~ 与 ^ 走文本命令", () => {
    assert.equal(escapeLatexText("50%_a&b#c$d{e}"), "50\\%\\_a\\&b\\#c\\$d\\{e\\}");
    assert.equal(escapeLatexText("a\\b"), "a\\textbackslash{}b");
    assert.equal(escapeLatexText("1~2^3"), "1\\textasciitilde{}2\\textasciicircum{}3");
  });
});

describe("模板能编译（需要 latexmk）", () => {
  test("真 latexmk：status ok、至少一页、参考文献被 bibtex 处理", async (t) => {
    const probe = createLatexProbe();
    const available = await probe.probe();
    if (!available.ok) {
      t.skip(`latexmk 未安装：${available.message}`);
      return;
    }

    const dir = temp();
    writePaperTemplate(dir, "Retrieval Practice");
    const outcome = await new LatexRunner().compile({ dir });
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
    const result = outcome.result;

    // 失败时把真正的错误打出来，别让断言只丢一个 status 字符串
    assert.ok(
      result.status === "ok" || result.status === "warning-only",
      `status=${result.status} errors=${JSON.stringify(result.errors)} tail=${result.logTail ?? ""}`,
    );
    assert.equal(result.errors.length, 0);
    assert.ok(result.pages !== null && result.pages >= 1, `页数是 ${String(result.pages)}`);
    assert.ok(existsSync(join(dir, "build", "main.pdf")));
    assert.equal(result.pdfFresh, true);

    // bibtex 已跑：.bbl 里是三条解析好的条目（引用没被解析时 .bbl 是空的）
    const bbl = readFileSync(join(dir, "build", "main.bbl"), "utf8");
    for (const key of ["lewis2020rag", "karpukhin2020dpr", "vaswani2017attention"]) {
      assert.ok(bbl.includes(key), `.bbl 里没有 ${key}`);
    }
    // 正文的 \citep 解析成了 [1]/[2]：未定义引用会在 log 里留 "Citation ... undefined"
    const log = readFileSync(join(dir, "build", "main.log"), "utf8");
    assert.doesNotMatch(log, /Citation .* undefined/);
    assert.doesNotMatch(log, /Reference .* undefined/);
  });
});
