/**
 * 编译根模型的回归网（2026-11 多 root）：判定顺序、magic 链、授权根、
 * 子目录 root、jobname 与 per-root 的 outDir。
 *
 * 与 resolve.test.ts 同一个纪律：临时目录里造真项目（真 fs），能读出来的才叫事实。
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeProjectConfig, resolveLatexPlan } from "./resolve.ts";

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "orbita-latex-root-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

const DOC = "\\documentclass{article}\\begin{document}x\\end{document}\n";

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("root 判定顺序", () => {
  test("request.main 优先于 file 的 magic（「忽略这一行、编我点的那个」）", () => {
    const dir = project({
      "main.tex": DOC,
      "ch1.tex": "% !TEX root = main.tex\nChapter one\n",
    });
    const plan = resolveLatexPlan(dir, { main: "ch1.tex", file: "ch1.tex", boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.root.path, "ch1.tex");
    assert.equal(plan.root.source, "request");
    assert.equal(plan.root.declaredBy, null);
  });

  test("子文件里的 % !TEX root 生效：root 是主文件，declaredBy 指回写它的那一行", () => {
    const dir = project({
      "main.tex": DOC,
      "sections/ch1.tex": "% !TEX root = ../main.tex\nSome text.\n",
    });
    const plan = resolveLatexPlan(dir, { file: "sections/ch1.tex", boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.root.path, "main.tex");
    assert.equal(plan.root.source, "magic");
    assert.deepEqual(plan.root.declaredBy, { file: "sections/ch1.tex", line: 1 });
  });

  test("链式 magic 最多跟 2 跳（A→B→C 停在 C）", () => {
    const dir = project({
      "a.tex": "% !TEX root = b.tex\nA\n",
      "b.tex": "% !TEX root = c.tex\nB\n",
      "c.tex": "% !TEX root = d.tex\nC\n",
      "d.tex": DOC,
    });
    const plan = resolveLatexPlan(dir, { file: "a.tex", boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.root.path, "c.tex");
    assert.equal(plan.root.declaredBy?.file, "b.tex");
  });

  test("magic 指回自己：当没写，继续走约定（main.tex）", () => {
    const dir = project({
      "main.tex": DOC,
      "notes.tex": "% !TEX root = notes.tex\nNotes\n",
    });
    const plan = resolveLatexPlan(dir, { file: "notes.tex", boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.root.path, "main.tex");
    assert.equal(plan.root.source, "convention");
  });

  test("magic 指向不存在的文件：no-main-file，说清哪份文件第几行指向了什么", () => {
    const dir = project({
      "main.tex": DOC,
      "ch1.tex": "% !TEX root = gone.tex\nChapter\n",
    });
    const plan = resolveLatexPlan(dir, { file: "ch1.tex", boundary: [dir] });
    assert.equal(plan.status, "no-main-file");
    if (plan.status !== "no-main-file") return;
    assert.match(plan.detail, /ch1\.tex line 1/);
    assert.match(plan.detail, /does not exist/);
  });

  test("子目录里的 root 会被发现（不再是「顶层没有 .tex 就没有项目」）", () => {
    const dir = project({ "paper/main.tex": DOC });
    const plan = resolveLatexPlan(dir, { boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.root.path, "paper/main.tex");
    assert.equal(plan.root.source, "scan");
    // 产物目录相对 root 所在目录：paper/build
    assert.equal(plan.outDir, join(resolve(dir), "paper", "build"));
    assert.equal(plan.root.outDirRelative, "paper/build");
  });

  test("当前文件自己含 \\documentclass → focus（在递归唯一之前）", () => {
    const dir = project({
      "doc.tex": DOC,
      "notes.tex": "% 只是一些笔记\n",
    });
    const plan = resolveLatexPlan(dir, { file: "doc.tex", boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.root.path, "doc.tex");
    assert.equal(plan.root.source, "focus");
  });

  test("no-main-file 时的候选是递归发现的 root（含子目录），不是顶层 .tex 清单", () => {
    const dir = project({ "a/main.tex": DOC, "b/paper.tex": DOC, "README.md": "x" });
    const plan = resolveLatexPlan(dir, { boundary: [dir] });
    assert.equal(plan.status, "no-main-file");
    if (plan.status !== "no-main-file") return;
    assert.deepEqual(plan.candidates, ["a/main.tex", "b/paper.tex"]);
  });
});

describe("授权根（magic 不许把 cwd / outDir 带出根外）", () => {
  test("root 指向授权根之外：root-outside-workspace，不返回任何计划", () => {
    const workspace = project({ "proj/main.tex": DOC, "evil.tex": DOC, "proj/ch1.tex": "% !TEX root = ../evil.tex\n" });
    const plan = resolveLatexPlan(join(workspace, "proj"), {
      file: "ch1.tex",
      boundary: [join(workspace, "proj")],
    });
    assert.equal(plan.status, "root-outside-workspace");
    if (plan.status !== "root-outside-workspace") return;
    assert.match(plan.detail, /outside the authorized workspace/);
  });

  test("显式 main 也不许出根：root-outside-workspace", () => {
    const workspace = project({ "proj/main.tex": DOC, "outside.tex": DOC });
    const plan = resolveLatexPlan(join(workspace, "proj"), {
      main: join(workspace, "outside.tex"),
      boundary: [join(workspace, "proj")],
    });
    assert.equal(plan.status, "root-outside-workspace");
  });

  test("根内跨目录的 magic 允许（boundary 是授权根，不是项目目录）", () => {
    const workspace = project({
      "book/main.tex": DOC,
      "shared/intro.tex": "% !TEX root = ../book/main.tex\nintroduction\n",
    });
    const plan = resolveLatexPlan(join(workspace, "book"), {
      file: "../shared/intro.tex",
      boundary: [workspace],
    });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.root.path, "main.tex");
    assert.equal(plan.root.source, "magic");
  });
});

describe("per-root 配置（outDir 相对 root 目录 / jobname）", () => {
  test("outDir 与 jobname 落在 argv，产物目录相对 root 所在目录", () => {
    const dir = project({
      "paper/main.tex": DOC,
      ".orbita/latex.json": JSON.stringify({
        version: 2,
        activeRoot: "paper/main.tex",
        roots: [{ path: "paper/main.tex", outDir: "out", jobname: "review", engine: "xelatex" }],
      }),
    });
    const plan = resolveLatexPlan(dir, { boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.outDir, join(resolve(dir), "paper", "out"));
    assert.equal(plan.jobname, "review");
    assert.equal(plan.engine, "xelatex");
    assert.ok(plan.argv.includes("-jobname=review"));
    assert.ok(plan.argv.includes(`-outdir=${join(resolve(dir), "paper", "out")}`));
  });

  test("outDir 写成绝对路径 / 带 .. 被丢弃（回默认 build，不出根）", () => {
    const dir = project({
      "main.tex": DOC,
      ".orbita/latex.json": JSON.stringify({
        version: 2,
        roots: [
          { path: "main.tex", outDir: "/tmp/elsewhere" },
          { path: "main.tex", outDir: "../escape" },
        ],
      }),
    });
    const plan = resolveLatexPlan(dir, { boundary: [dir] });
    assert.equal(plan.status, "ok");
    if (plan.status !== "ok") return;
    assert.equal(plan.outDir, join(resolve(dir), "build"));
  });
});

describe("配置 v1 → v2 迁移", () => {
  test("旧的 main / engine / outDir / args 搬到 roots[0]，写回不再有 main", () => {
    const v2 = normalizeProjectConfig({
      main: "paper.tex",
      engine: "xelatex",
      outDir: "out",
      args: ["-quiet"],
    });
    assert.deepEqual(v2, {
      version: 2,
      activeRoot: "paper.tex",
      roots: [{ path: "paper.tex", engine: "xelatex", outDir: "out", args: ["-quiet"] }],
    });
    assert.equal("main" in v2, false);
    assert.equal("engine" in v2, false);
  });

  test("没有 main 的 v1 项目级配置：迁到这次解析出的有效 root", () => {
    const v2 = normalizeProjectConfig({ engine: "lualatex", outDir: "out" }, "main.tex");
    assert.deepEqual(v2.roots, [{ path: "main.tex", engine: "lualatex", outDir: "out" }]);
    assert.equal(v2.activeRoot, "main.tex");
  });

  test("activeRoot 不在 roots 里 → 为它补一条；重复 path 只留第一条", () => {
    const v2 = normalizeProjectConfig({
      version: 2,
      activeRoot: "appendix.tex",
      roots: [{ path: "main.tex" }, { path: "main.tex", outDir: "dup" }],
    });
    assert.deepEqual(v2.roots, [{ path: "main.tex" }, { path: "appendix.tex" }]);
    assert.equal(v2.activeRoot, "appendix.tex");
  });
});
