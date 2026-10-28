/**
 * 主文件解析与配方的回归网 —— 每个用例在临时目录里造一个真项目（真 fs，
 * 不注入假依赖）：解析逻辑的价值全在「磁盘上到底有什么」与优先级上，
 * 用假 fs 测只会测到我们自己的假设。
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectEngine,
  expandRecipe,
  parseMagicComments,
  parseProjectConfig,
  resolveLatexPlan,
  splitOptions,
} from "./resolve.ts";

const roots: string[] = [];

/** 造一个项目目录：files 的 key 是相对路径 */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "orbita-latex-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("parseMagicComments", () => {
  test("头部注释块里的三项都认", () => {
    const magic = parseMagicComments(
      [
        "% !TEX program = xelatex",
        "% !TeX root = ../thesis.tex",
        '% !TEX options = -shell-escape -jobname="my paper"',
        "\\documentclass{article}",
      ].join("\n"),
    );
    assert.equal(magic.program, "xelatex");
    assert.equal(magic.root, "../thesis.tex");
    assert.deepEqual(magic.options, ["-shell-escape", "-jobname=my paper"]);
  });

  test("第一行有内容的非注释行之后就不再扫（正文里的 % !TEX 是注释，不是指令）", () => {
    const magic = parseMagicComments(["\\documentclass{article}", "% !TEX program = lualatex"].join("\n"));
    assert.equal(magic.program, null);
  });

  test("头部空行不终止扫描；认不出的 program 当没写", () => {
    const magic = parseMagicComments(["\n\n% !TEX program = latex", "% !TEX root = main.tex"].join("\n"));
    assert.equal(magic.program, null);
    assert.equal(magic.root, "main.tex");
  });
});

describe("parseProjectConfig / splitOptions", () => {
  test("坏值逐项丢弃，好值保留", () => {
    const config = parseProjectConfig({
      main: "paper.tex",
      engine: "xelatex",
      outDir: 42,
      args: ["-quiet", 7, ""],
      recipe: "not-an-array",
    });
    assert.deepEqual(config, { main: "paper.tex", engine: "xelatex", args: ["-quiet"] });
  });

  test("引号包住的片段算一个参数", () => {
    assert.deepEqual(splitOptions("-a -b='x y' -c"), ["-a", "-b=x y", "-c"]);
  });

  test("compileOnSave 只认布尔：字符串 true / 数字 1 当作没写", () => {
    assert.equal(parseProjectConfig({ compileOnSave: true }).compileOnSave, true);
    assert.equal(parseProjectConfig({ compileOnSave: false }).compileOnSave, false);
    assert.equal(parseProjectConfig({ compileOnSave: "true" }).compileOnSave, undefined);
    assert.equal(parseProjectConfig({}).compileOnSave, undefined);
  });
});

describe("resolveLatexPlan —— 主文件", () => {
  test("目录里有 main.tex 就用它，默认引擎 pdf", () => {
    const dir = project({ "main.tex": "\\documentclass{article}\\begin{document}hi\\end{document}" });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.mainName, "main.tex");
    assert.equal(plan.dir, resolve(dir));
    assert.equal(plan.engine, "pdf");
    assert.equal(plan.engineSource, "auto");
    assert.deepEqual(plan.argv, [
      "-pdf",
      "-interaction=nonstopmode",
      "-file-line-error",
      "-synctex=1",
      `-outdir=${join(resolve(dir), "build")}`,
      "main.tex",
    ]);
  });

  test("没有 main.tex 但只有一个 .tex：用它", () => {
    const dir = project({ "paper.tex": "\\documentclass{article}" });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status === "ok") assert.equal(plan.mainName, "paper.tex");
  });

  test("多个候选且没有 main.tex：no-main-file 并带候选清单", () => {
    const dir = project({ "a.tex": "a", "b.tex": "b" });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "no-main-file");
    if (plan.status !== "no-main-file") return;
    assert.deepEqual(plan.candidates, ["a.tex", "b.tex"]);
    assert.match(plan.detail, /pass main/);
  });

  test("显式 main 不存在时不悄悄回落到 main.tex", () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    const plan = resolveLatexPlan(dir, { main: "paper.tex" });
    assert.equal(plan.status, "no-main-file");
    if (plan.status === "no-main-file") assert.match(plan.detail, /does not exist/);
  });

  test("显式 main 必须是 .tex", () => {
    const dir = project({ "main.tex": "\\documentclass{article}", "notes.txt": "hi" });
    const plan = resolveLatexPlan(dir, { main: "notes.txt" });
    assert.equal(plan.status, "no-main-file");
    if (plan.status === "no-main-file") assert.match(plan.detail, /must be a \.tex file/);
  });

  test(".orbita/latex.json 的 main 优先于 main.tex", () => {
    const dir = project({
      "main.tex": "\\documentclass{article}",
      "paper.tex": "\\documentclass{article}",
      ".orbita/latex.json": JSON.stringify({ main: "paper.tex" }),
    });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status === "ok") assert.equal(plan.mainName, "paper.tex");
  });
});

describe("resolveLatexPlan —— 引擎", () => {
  test("正文有中文 → xelatex", () => {
    const dir = project({ "main.tex": "\\documentclass{article}\\begin{document}你好\\end{document}" });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status === "ok") {
      assert.equal(plan.engine, "xelatex");
      assert.equal(plan.argv[0], "-xelatex");
    }
  });

  test("ctex 宏包 / ctexart 文档类都算 CJK 信号", () => {
    assert.equal(detectEngine("\\usepackage[UTF8]{ctex}"), "xelatex");
    assert.equal(detectEngine("\\documentclass{ctexart}"), "xelatex");
    assert.equal(detectEngine("\\documentclass{article}"), "pdf");
  });

  test("只出现在注释里的中文不换引擎", () => {
    assert.equal(detectEngine("% 这是一份英文论文的注释\n\\documentclass{article}"), "pdf");
  });

  test("优先级：请求 > magic > 项目配置 > 自动", () => {
    const dir = project({
      "main.tex": "% !TEX program = lualatex\n\\documentclass{article}",
      ".orbita/latex.json": JSON.stringify({ engine: "xelatex" }),
    });
    const automatic = resolveLatexPlan(dir, {});
    assert.equal(automatic.status, "ok");
    if (automatic.status === "ok") {
      assert.equal(automatic.engine, "lualatex");
      assert.equal(automatic.engineSource, "magic");
    }
    const explicit = resolveLatexPlan(dir, { engine: "pdf" });
    if (explicit.status === "ok") {
      assert.equal(explicit.engine, "pdf");
      assert.equal(explicit.engineSource, "request");
    }
  });

  test("没有 magic 时项目配置的 engine 生效", () => {
    const dir = project({
      "main.tex": "\\documentclass{article}",
      ".orbita/latex.json": JSON.stringify({ engine: "xelatex" }),
    });
    const plan = resolveLatexPlan(dir, {});
    if (plan.status === "ok") {
      assert.equal(plan.engine, "xelatex");
      assert.equal(plan.engineSource, "config");
    }
  });
});

describe("resolveLatexPlan —— magic root", () => {
  test("root 改变主文件与工作目录", () => {
    const dir = project({
      "main.tex": "\\documentclass{book}\\begin{document}\\input{sections/one}\\end{document}",
      "sections/one.tex": "% !TEX root = ../main.tex\nSome text.",
    });
    // 从子文档目录起解析：显式给了子文件，root 指回主文件
    const plan = resolveLatexPlan(join(dir, "sections"), { main: "one.tex" });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.mainPath, join(resolve(dir), "main.tex"));
    assert.equal(plan.dir, resolve(dir));
    assert.equal(plan.mainName, "main.tex");
  });

  test("root 指向不存在的文件：no-main-file，不瞎编一个主文件", () => {
    const dir = project({ "one.tex": "% !TEX root = ../gone.tex\n\\documentclass{article}" });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "no-main-file");
    if (plan.status === "no-main-file") assert.match(plan.detail, /does not exist/);
  });
});

describe("argv 配方", () => {
  test("outDir 与 args 进默认命令", () => {
    const dir = project({
      "main.tex": "\\documentclass{article}",
      ".orbita/latex.json": JSON.stringify({ outDir: "out", args: ["-quiet"] }),
    });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.outDir, join(resolve(dir), "out"));
    // 默认参数 → args → 主文件名
    assert.deepEqual(plan.argv.slice(-3), [`-outdir=${join(resolve(dir), "out")}`, "-quiet", "main.tex"]);
    assert.equal(plan.argv[0], "-pdf");
  });

  test("recipe[0] 是可执行文件，其余是参数，占位符只展开在参数里", () => {
    const dir = project({
      "main.tex": "\\documentclass{article}",
      ".orbita/latex.json": JSON.stringify({
        recipe: ["latexmk", "-xelatex", "-outdir=%OUTDIR%", "%DIR%/%DOCFILE%", "%DOC%"],
      }),
    });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.command, "latexmk");
    assert.deepEqual(plan.argv, [
      "-xelatex",
      `-outdir=${join(resolve(dir), "build")}`,
      `${resolve(dir)}/main.tex`,
      "main",
    ]);
  });

  test("recipe 不给可执行文件的位置时只看第一个 token（不当整条给 latexmk）", () => {
    const dir = project({
      "main.tex": "\\documentclass{article}",
      ".orbita/latex.json": JSON.stringify({ recipe: ["xelatex", "-interaction=nonstopmode", "%DOCFILE%"] }),
    });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.command, "xelatex");
    assert.deepEqual(plan.argv, ["-interaction=nonstopmode", "main.tex"]);
  });

  test("默认命令没有可执行文件覆盖（command = null，用探测到的 latexmk）", () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    const plan = resolveLatexPlan(dir, {});
    assert.equal(plan.status, "ok");
    if (plan.status === "ok") assert.equal(plan.command, null);
  });

  test("占位符展开不认识的 %FOO% 原样保留", () => {
    assert.deepEqual(expandRecipe(["%DOC%.pdf", "%FOO%"], { doc: "main", docfile: "main.tex", dir: "/p", outdir: "/p/build" }), [
      "main.pdf",
      "%FOO%",
    ]);
  });
});
