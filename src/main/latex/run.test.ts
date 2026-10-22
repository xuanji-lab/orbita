/**
 * LatexRunner 的回归网 —— 并发记账、超时、取消、产物定位与陈旧日志。
 *
 * 不起真 latexmk：`,orbita/latex.json` 的 recipe 让 `LatexRunner` 去 spawn **node**
 * （`recipe[0]` 是可执行文件这条语义的顺手用法），脚本按测试需要挂死、写文件或
 * 立刻退出。真编译的正确性由 parse-log 的真实日志夹具与人工验收盖住；这里盖的是
 * 「谁在跑、跑完读哪份文件、判成什么」——恰恰是评审 M3/M2/S5 说没测的那几件。
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LatexProbe } from "./probe.ts";
import { LatexRunner } from "./run.ts";
import type { LatexResult, LatexRunOutcome } from "../../shared/latex.ts";

const roots: string[] = [];
const nodeExe = process.execPath;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "orbita-latex-run-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

function texProject(recipe: string[]): string {
  return project({
    "main.tex": "\\documentclass{article}\\begin{document}hi\\end{document}",
    ".orbita/latex.json": JSON.stringify({ recipe }),
  });
}

function probe(available = true): LatexProbe {
  return {
    probe: async () => ({
      ok: available,
      latexmk: available ? "latexmk" : null,
      version: available ? "Latexmk … Version 0.0 (fake)" : null,
      engines: available ? ["pdf" as const] : [],
      source: available ? ("path" as const) : null,
      message: available ? "" : "latexmk was not found.",
    }),
    refresh: () => undefined,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 挂死的 node 进程：测超时与取消用，不烧 CPU */
const HANG = ["-e", "setTimeout(() => undefined, 60000)"];

/** 断言 outcome 成功并取 result（失败时把 error 抛出来，别让断言变成 undefined 爆炸） */
function resultOf(outcome: LatexRunOutcome): LatexResult {
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  return outcome.result;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("LatexRunner —— 拒绝路径", () => {
  test("latexmk 没装：not-installed，不 spawn 任何东西", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    const outcome = await new LatexRunner(probe(false)).compile({ dir });
    const result = resultOf(outcome);
    assert.equal(result.status, "not-installed");
    assert.equal(result.pdf, null);
    assert.equal(result.pdfFresh, false);
  });

  test("没有 .tex：no-main-file，带候选说明", async () => {
    const dir = project({ "README.md": "not a paper" });
    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "no-main-file");
    assert.match(result.errors[0]?.message ?? "", /No \.tex file/);
  });
});

describe("LatexRunner —— 超时与取消", () => {
  test("超时：按构造参数缩到 300ms，杀进程树后返回 timeout", async () => {
    const dir = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { timeoutMs: 300 });
    const started = Date.now();
    const result = resultOf(await runner.compile({ dir }));
    const elapsed = Date.now() - started;
    assert.equal(result.status, "timeout");
    assert.ok(elapsed >= 300, `只等了 ${elapsed}ms，超时没生效`);
    // 挂死的进程被杀了：runner 手里不再有子进程（cancelAll 是幂等的空转）
    runner.cancelAll();
  });

  test("取消：cancelAll 杀掉在编的进程，回 cancelled 而不是挂着", async () => {
    const dir = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { timeoutMs: 30_000 });
    const pending = runner.compile({ dir });
    await sleep(300);
    runner.cancelAll();
    const result = resultOf(await pending);
    assert.equal(result.status, "cancelled");
  });
});

describe("LatexRunner —— 并发互斥", () => {
  test("同项目第二次请求被拒；第一次仍按取消收尾", async () => {
    const dir = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { timeoutMs: 30_000 });
    const first = runner.compile({ dir });
    await sleep(300);
    const second = await runner.compile({ dir });
    assert.equal(second.ok, false);
    assert.match(second.ok ? "" : second.error, /already running/i);
    runner.cancelAll();
    assert.equal(resultOf(await first).status, "cancelled");
  });

  test("全局最多同时 2 个：第三个项目被拒", async () => {
    const a = texProject([nodeExe, ...HANG]);
    const b = texProject([nodeExe, ...HANG]);
    const c = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { timeoutMs: 30_000 });
    const first = runner.compile({ dir: a });
    const second = runner.compile({ dir: b });
    await sleep(400);
    const third = await runner.compile({ dir: c });
    assert.equal(third.ok, false);
    assert.match(third.ok ? "" : third.error, /2 LaTeX builds are running/);
    runner.cancelAll();
    await Promise.all([first, second]);
  });
});

describe("LatexRunner —— 产物定位（M2）", () => {
  test("recipe 不带 -outdir：按日志里的 Output written 找到主文件旁的 PDF", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    // 假编译器：在主文件目录里写 PDF 与日志（模拟没有 -outdir 的 recipe）
    writeFileSync(
      join(dir, "fake-compiler.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'writeFileSync(join(dir, "main.pdf"), "%PDF-1.4 fake\\n");',
        'writeFileSync(join(dir, "main.log"), "Output written on main.pdf (2 pages, 9 bytes).\\n");',
      ].join("\n"),
      "utf8",
    );
    const config = { recipe: [nodeExe, join(dir, "fake-compiler.mjs"), "%DIR%"] };
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(join(dir, ".orbita", "latex.json"), JSON.stringify(config), "utf8");

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "ok");
    assert.equal(result.pages, 2);
    assert.equal(result.pdf, join(resolve(dir), "main.pdf"));
    assert.equal(result.pdfFresh, true);
    assert.equal(result.logStale, false);
    assert.equal(result.logTail, null);
  });
});

describe("LatexRunner —— 陈旧日志与陈旧 PDF（M3/M4）", () => {
  test("同一坏文档连编两次：第二次仍拿到 file:line，但 pages 不来自陈旧日志", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    // 假 latexmk：第一次写日志与 PDF 后以 12 退出；第二次什么都不写直接 12
    // （真 latexmk 读 .fdb_latexmk 判定无事可做时就是这样，且**不会重写 .log**）
    writeFileSync(
      join(dir, "fake-compiler.mjs"),
      [
        'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'const marker = join(dir, ".ran-once");',
        "if (!existsSync(marker)) {",
        '  writeFileSync(marker, "");',
        '  mkdirSync(join(dir, "build"), { recursive: true });',
        '  writeFileSync(join(dir, "build", "main.log"), "./main.tex:4: Missing $ inserted.\\nOutput written on build/main.pdf (1 page, 21566 bytes).\\n");',
        '  writeFileSync(join(dir, "build", "main.pdf"), "%PDF-1.4 fake\\n");',
        "}",
        "process.exit(12);",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-compiler.mjs"), "%DIR%"] }),
      "utf8",
    );

    const runner = new LatexRunner(probe());
    const first = resultOf(await runner.compile({ dir }));
    assert.equal(first.status, "compile-error");
    assert.equal(first.logStale, false);
    assert.equal(first.errors[0]?.file, "main.tex");
    assert.equal(first.errors[0]?.line, 4);
    assert.equal(first.pages, 1, "本次写出的日志里的页数应当可用");
    assert.equal(first.pdfFresh, true);

    const second = resultOf(await runner.compile({ dir }));
    assert.equal(second.status, "compile-error");
    // 关键：诊断信息不能丢——错误照常来自那份没被重写的日志
    assert.equal(second.errors[0]?.file, "main.tex");
    assert.equal(second.errors[0]?.line, 4);
    assert.match(second.errors[0]?.message ?? "", /Missing \$ inserted/);
    // 但页数与产物不是这一次的事实
    assert.equal(second.logStale, true);
    assert.equal(second.pages, null);
    assert.equal(second.pdfFresh, false);
  });

  test("旧日志 7 pages + 本次直接失败：错误照常返回，pages 必须为 null", async () => {
    const dir = texProject([nodeExe, "-e", "process.exit(1)"]);
    // 上一轮成功留下的日志：页数 7、一条错。错误是证据（该给模型），页数不是
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(
      join(dir, "build", "main.log"),
      "./main.tex:2: Something from last time.\nOutput written on build/main.pdf (7 pages, 100 bytes).\n",
      "utf8",
    );

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "compile-error");
    assert.equal(result.logStale, true);
    assert.equal(result.pages, null, "陈旧日志里的 7 页不能当成这一次的");
    assert.ok(result.errors.some((issue) => issue.message.includes("Something from last time")));
    // 陈旧错误之外，本次的退出码也要说清楚（否则模型不知道这一次也失败了）
    assert.ok(result.errors.some((issue) => /exited with code 1/.test(issue.message)));
    assert.equal(result.pdf, null);
    assert.equal(result.pdfFresh, false);
  });

  test("成功但 latexmk 无事可做：status ok、logStale true、pages 不从旧日志取", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    // 假 latexmk：第一次写日志与 PDF 后回 0；第二次不写任何东西也回 0（Nothing to do）
    writeFileSync(
      join(dir, "fake-compiler.mjs"),
      [
        'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'const marker = join(dir, ".ran-once");',
        "if (!existsSync(marker)) {",
        '  writeFileSync(marker, "");',
        '  mkdirSync(join(dir, "build"), { recursive: true });',
        '  writeFileSync(join(dir, "build", "main.log"), "Output written on build/main.pdf (3 pages, 9 bytes).\\n");',
        '  writeFileSync(join(dir, "build", "main.pdf"), "%PDF-1.4 fake\\n");',
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-compiler.mjs"), "%DIR%"] }),
      "utf8",
    );

    const runner = new LatexRunner(probe());
    const first = resultOf(await runner.compile({ dir }));
    assert.equal(first.status, "ok");
    assert.equal(first.logStale, false);
    assert.equal(first.pages, 3);
    assert.equal(first.pdfFresh, true);

    const second = resultOf(await runner.compile({ dir }));
    assert.equal(second.status, "ok", "无事可做仍然是一次成功");
    assert.equal(second.logStale, true);
    assert.equal(second.pages, null, "旧日志里的 3 页不能当成这一次的");
    assert.equal(second.pdfFresh, false);
    assert.ok(second.pdf !== null, "已存在的 PDF 仍然要告诉模型在哪");
  });

  test("失败时磁盘上的旧 PDF：pdf 非 null 但 pdfFresh = false（文案据此说“earlier build”）", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "main.pdf"), "%PDF-1.4 old\n", "utf8");
    // 旧 PDF 比源文件新：pdfIsCurrent 会把它当成“与源码一致”，但 pdfFresh 必须是 false
    const config = { recipe: [nodeExe, "-e", "process.exit(1)"] };
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(join(dir, ".orbita", "latex.json"), JSON.stringify(config), "utf8");

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "compile-error");
    assert.equal(result.pdf, join(resolve(dir), "build", "main.pdf"));
    assert.equal(result.pdfFresh, false);
    assert.equal(result.logStale, false, "没有旧日志，就不该标 stale");
  });
});
