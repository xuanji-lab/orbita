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
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

/*
 * xelatex 的日志写的是 `.xdv`（它先出 XDV，再由 xdvipdfmx 转 PDF）。把 XDV 当产物
 * 交给调用方，打开的就是一个 .xdv——中文主路径上人人都踩。
 */
describe("LatexRunner —— 只把 .pdf 当产物（xelatex 的 .xdv）", () => {
  test("日志写 Output written on build/main.xdv，且两个文件都在：返回同目录同名的 .pdf", async () => {
    const dir = project({ "main.tex": "\\documentclass{ctexart}" });
    writeFileSync(
      join(dir, "fake-xelatex.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'const out = join(dir, "build");',
        "mkdirSync(out, { recursive: true });",
        // 真 xelatex 的顺序：先写 XDV，日志记 XDV，再由 xdvipdfmx 写 PDF
        'writeFileSync(join(out, "main.xdv"), "XDV");',
        'writeFileSync(join(out, "main.pdf"), "%PDF-1.5 fake\\n");',
        'writeFileSync(join(out, "main.log"), "Output written on build/main.xdv (1 page, 516 bytes).\\n");',
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-xelatex.mjs"), "%DIR%"] }),
      "utf8",
    );

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "ok");
    assert.equal(result.pdf, join(resolve(dir), "build", "main.pdf"));
    assert.equal(result.pages, 1);
    assert.equal(result.pdfFresh, true);
  });

  test("只有 .xdv、没有 .pdf：不返回 .xdv（否则调用方拿中间格式当 PDF）", async () => {
    const dir = project({ "main.tex": "\\documentclass{ctexart}" });
    writeFileSync(
      join(dir, "fake-xelatex.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'const out = join(dir, "build");',
        "mkdirSync(out, { recursive: true });",
        'writeFileSync(join(out, "main.xdv"), "XDV");',
        'writeFileSync(join(out, "main.log"), "Output written on build/main.xdv (1 page, 516 bytes).\\n");',
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-xelatex.mjs"), "%DIR%"] }),
      "utf8",
    );

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.pdf, null);
    assert.equal(result.pdfFresh, false);
    // 回 0 却没有 PDF 是假成功，得说清楚（不能悄悄交个 .xdv 蒙混过关）
    assert.equal(result.status, "compile-error");
    assert.ok(
      result.errors.some((issue) => issue.message.includes("main.xdv") && /not a PDF/.test(issue.message)),
      result.errors.map((issue) => issue.message).join(" | "),
    );
  });

  test("大写 .PDF 也算 PDF", async () => {
    const dir = project({ "main.tex": "\\documentclass{ctexart}" });
    writeFileSync(
      join(dir, "fake-xelatex.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'const out = join(dir, "build");',
        "mkdirSync(out, { recursive: true });",
        'writeFileSync(join(out, "main.PDF"), "%PDF-1.5 fake\\n");',
        'writeFileSync(join(out, "main.log"), "Output written on build/main.PDF (1 page, 9 bytes).\\n");',
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-xelatex.mjs"), "%DIR%"] }),
      "utf8",
    );

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "ok");
    assert.ok(result.pdf !== null && result.pdf.endsWith("main.PDF"), `拿到的是 ${String(result.pdf)}`);
  });
});

/*
 * lualatex 的日志写 `Output written on main.pdf`（名字不带 -outdir 前缀）。项目根又有
 * 一份上一轮的 main.pdf 时，“先列到谁就是谁”会把旧文件当产物，本次新写的
 * build/main.pdf 反被丢掉。
 */
describe("LatexRunner —— 日志裸文件名与「本次新写」优先", () => {
  const OLD = (): Date => new Date(Date.now() - 60_000);

  test("根目录旧 main.pdf + build 本次新写：返回 build/main.pdf 且判 ok", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    // 上一轮留在根目录的 PDF：比本次编译开始早一分钟（不能靠“刚好慢一拍”碰巧过）
    writeFileSync(join(dir, "main.pdf"), "%PDF-1.4 old\n", "utf8");
    utimesSync(join(dir, "main.pdf"), OLD(), OLD());
    writeFileSync(
      join(dir, "fake-lualatex.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'const out = join(dir, "build");',
        "mkdirSync(out, { recursive: true });",
        // lualatex 的真实写法：产物名就是 main.pdf，不带 outdir 前缀
        'writeFileSync(join(out, "main.log"), "Output written on main.pdf (2 pages, 9 bytes).\\n");',
        'writeFileSync(join(out, "main.pdf"), "%PDF-1.5 new\\n");',
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-lualatex.mjs"), "%DIR%"] }),
      "utf8",
    );

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "ok", result.errors.map((issue) => issue.message).join(" | "));
    assert.equal(result.pdf, join(resolve(dir), "build", "main.pdf"));
    assert.equal(result.pages, 2);
    assert.equal(result.pdfFresh, true);
  });

  test("本次新写的是根目录那份：压过先被列到的 build/ 旧 PDF（新写的优先，不是顺序优先）", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "main.pdf"), "%PDF-1.4 old\n", "utf8");
    utimesSync(join(dir, "build", "main.pdf"), OLD(), OLD());
    // 不传 -outdir 的 recipe：本次产物落在主文件旁边
    writeFileSync(
      join(dir, "fake-compiler.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'writeFileSync(join(dir, "main.log"), "Output written on main.pdf (1 page, 9 bytes).\\n");',
        'writeFileSync(join(dir, "main.pdf"), "%PDF-1.5 new\\n");',
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-compiler.mjs"), "%DIR%"] }),
      "utf8",
    );

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.status, "ok");
    assert.equal(result.pdf, join(resolve(dir), "main.pdf"));
    assert.equal(result.pdfFresh, true);
  });

  test("dvi-only recipe（回 0 只写出 main.dvi）：不交 DVI，但文案要说清「编出了非 PDF」", async () => {
    const dir = project({ "main.tex": "\\documentclass{article}" });
    writeFileSync(
      join(dir, "fake-latex.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const dir = process.argv[2];",
        'writeFileSync(join(dir, "main.log"), "Output written on main.dvi (1 page, 100 bytes).\\n");',
        'writeFileSync(join(dir, "main.dvi"), "DVI");',
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, ".orbita"), { recursive: true });
    writeFileSync(
      join(dir, ".orbita", "latex.json"),
      JSON.stringify({ recipe: [nodeExe, join(dir, "fake-latex.mjs"), "%DIR%"] }),
      "utf8",
    );

    const result = resultOf(await new LatexRunner(probe()).compile({ dir }));
    assert.equal(result.pdf, null);
    assert.equal(result.status, "compile-error");
    const messages = result.errors.map((issue) => issue.message).join(" | ");
    assert.match(messages, /main\.dvi/, messages);
    assert.match(messages, /not a PDF/, messages);
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
