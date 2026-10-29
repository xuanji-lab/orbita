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
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LatexProbe } from "./probe.ts";
import { cleanArgv, cleanResult, LatexRunner } from "./run.ts";
import { latexMaxConcurrent, LATEX_IDLE_TIMEOUT_MS, LATEX_TOTAL_TIMEOUT_MS, type LatexResult, type LatexRunOutcome } from "../../shared/latex.ts";

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
      searched: available ? ["/usr/bin"] : ["/usr/bin", "/opt/texlive"],
    }),
    refresh: () => undefined,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 给等结果的用例加一个硬截止，坏了要报错而不是把测试挂死 */
async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 挂死的 node 进程：不写任何日志，测总时长闸与取消用，不烧 CPU */
const HANG = ["-e", "setTimeout(() => undefined, 60000)"];

/** 有 main.tex 但不带 recipe 的项目 */
function plainProject(): string {
  return project({ "main.tex": "\\documentclass{article}\\begin{document}hi\\end{document}" });
}

/**
 * 在项目里装一个假编译器（`recipe[0]` = node，脚本收项目目录作 argv[2]）。
 * 超时判据只看日志文件，所以这里的脚本要能精确控制 .log 的写入节奏。
 */
function fakeCompiler(dir: string, lines: string[]): void {
  const script = join(dir, "fake-compiler.mjs");
  writeFileSync(script, lines.join("\n"), "utf8");
  mkdirSync(join(dir, ".orbita"), { recursive: true });
  writeFileSync(
    join(dir, ".orbita", "latex.json"),
    JSON.stringify({ recipe: [nodeExe, script, "%DIR%"] }),
    "utf8",
  );
}

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

describe("LatexRunner —— 超时（日志静默与总时长两道闸）", () => {
  test("日志持续增长就不算卡住：时钟只在日志增长时前进，结果与宿主负载无关", async () => {
    const dir = plainProject();
    // 编译器只挂着等 .stop；日志由测试进程写、时间由注入时钟推。
    // 两者在同一个同步回合里完成，看门狗无论何时 tick 都只能看到“刚有增长”，
    // 永远不会累计出静默——不再依赖墙钟余量，也不受子进程调度延迟影响。
    fakeCompiler(dir, [
      'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "const dir = process.argv[2];",
      'mkdirSync(join(dir, "build"), { recursive: true });',
      'const stop = join(dir, ".stop");',
      "while (!existsSync(stop)) await new Promise((done) => setTimeout(done, 10));",
      'writeFileSync(join(dir, "build", "main.log"), "Output written on build/main.pdf (2 pages, 9 bytes).\\n");',
      'writeFileSync(join(dir, "build", "main.pdf"), "%PDF-1.4 fake\\n");',
    ]);
    let clock = 0;
    const runner = new LatexRunner(probe(), {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 600_000,
      pollIntervalMs: 10,
      now: () => clock,
    });
    const pending = runner.compile({ dir });
    await sleep(100);
    mkdirSync(join(dir, "build"), { recursive: true });
    const log = join(dir, "build", "main.log");
    // 20 次增长、每次逻辑时间 +4 秒（< 5 秒静默阀），累计推过 80 秒：
    // 若看门狗不认增长，第一次静默判断就会在第 2 步之后杀掉它
    for (let i = 0; i < 20; i += 1) {
      appendFileSync(log, `[${String(i)}] 建字体缓存…\n`);
      clock += 4_000;
      await sleep(5);
    }
    writeFileSync(join(dir, ".stop"), "");
    const result = resultOf(await withDeadline(pending, 20_000, "编译没有在 20 秒内结束"));
    assert.equal(result.status, "ok");
    assert.equal(result.timeoutKind, null);
    assert.equal(result.pages, 2);
  });

  test("日志静默到点：杀进程树，status timeout + timeoutKind idle；文案不断言死循环", async () => {
    const dir = plainProject();
    // 只写一行日志就挂住：之后一直没有新输出，就是死循环的样子
    fakeCompiler(dir, [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "const dir = process.argv[2];",
      'mkdirSync(join(dir, "build"), { recursive: true });',
      'writeFileSync(join(dir, "build", "main.log"), "starting…\\n");',
      "setTimeout(() => undefined, 60000);",
    ]);
    const runner = new LatexRunner(probe(), { idleTimeoutMs: 400, totalTimeoutMs: 30_000, pollIntervalMs: 50 });
    const started = Date.now();
    const result = resultOf(await runner.compile({ dir }));
    const elapsed = Date.now() - started;
    assert.equal(result.status, "timeout");
    assert.equal(result.timeoutKind, "idle");
    assert.ok(elapsed >= 400, `只等了 ${elapsed}ms，静默超时没生效`);
    assert.ok(elapsed < 10_000, `等了 ${elapsed}ms，静默超时没有尽快生效`);
    // 日志按 4 KiB 块落盘，合法但耗时的编译也会长时间不动，所以不能断言“卡住”
    assert.match(result.errors[0]?.message ?? "", /连续 \d+\.\d 秒没有新的日志输出/);
    assert.match(result.errors[0]?.message ?? "", /可能是长时间计算/);
    assert.doesNotMatch(result.errors[0]?.message ?? "", /编译卡住/);
    // 挂死的进程被杀了：runner 手里不再有子进程（cancelAll 是幂等的空转）
    runner.cancelAll();
  });

  test("日志一份都没生成：不算静默，交给总时长闸（区分 timeoutKind total）", async () => {
    const dir = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { idleTimeoutMs: 200, totalTimeoutMs: 700, pollIntervalMs: 50 });
    const started = Date.now();
    const result = resultOf(await runner.compile({ dir }));
    const elapsed = Date.now() - started;
    assert.equal(result.status, "timeout");
    assert.equal(result.timeoutKind, "total", "没有日志时不能按静默判卡住");
    assert.ok(elapsed >= 700, `只等了 ${elapsed}ms，总时长闸没生效`);
    assert.match(result.errors[0]?.message ?? "", /总时长上限/);
    // 日志一份都没生成（自定义 recipe 不写 .log）：文案要说清“没有可用的日志输出”
    assert.match(result.errors[0]?.message ?? "", /没有可用的日志输出/);
  });

  test("日志被轮换（删除）不等于卡住：静默不累计，只在总时长到点被杀", async () => {
    const dir = plainProject();
    // 编译器只挂着；日志与时间都由测试驱动，不靠“删日志耗时 300ms”去和静默阀赛跑
    fakeCompiler(dir, ["setTimeout(() => undefined, 60000);"]);
    let clock = 0;
    const runner = new LatexRunner(probe(), {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 120_000,
      pollIntervalMs: 10,
      now: () => clock,
    });
    let settled = false;
    const pending = runner.compile({ dir });
    void pending.then(() => {
      settled = true;
    });
    await sleep(100);
    mkdirSync(join(dir, "build"), { recursive: true });
    const log = join(dir, "build", "main.log");
    writeFileSync(log, "round one\n");
    clock += 2_000; // 先让看门狗看到一次增长
    await sleep(50);
    rmSync(log, { force: true }); // 轮换：日志消失
    clock = 20_000; // 逻辑上已超过 idle，但一份日志都不存在
    await sleep(100);
    assert.equal(settled, false, "日志被删不能当成静默杀掉");
    // 继续推逻辑时间直到总时长闸到点：无论 spawn 落在哪个逻辑时刻，都能超过总时长
    for (let i = 0; i < 50 && !settled; i += 1) {
      clock += 200_000;
      await sleep(20);
    }
    const result = resultOf(await withDeadline(pending, 20_000, "总时长闸没有在 20 秒内杀掉进程"));
    assert.equal(result.status, "timeout");
    assert.equal(result.timeoutKind, "total", "日志消失不等于进程卡住，只能由总时长闸收尾");
    // 见过日志（后来被轮换）：不能反过来说“没有可用的日志输出”
    assert.doesNotMatch(result.errors[0]?.message ?? "", /没有可用的日志输出/);
  });

  test("取消：cancelAll 杀掉在编的进程，回 cancelled 而不是挂着", async () => {
    const dir = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { idleTimeoutMs: 30_000, totalTimeoutMs: 30_000 });
    const pending = runner.compile({ dir });
    await sleep(300);
    runner.cancelAll();
    const result = resultOf(await pending);
    assert.equal(result.status, "cancelled");
    assert.equal(result.timeoutKind, null);
  });
});

describe("LatexRunner —— 并发（按内存定上限，满了明确拒绝）", () => {
  test("同项目第二次请求被拒；第一次仍按取消收尾", async () => {
    const dir = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { totalTimeoutMs: 30_000, totalMemoryBytes: 32 * 1024 ** 3 });
    const first = runner.compile({ dir });
    await sleep(300);
    const second = await runner.compile({ dir });
    assert.equal(second.ok, false);
    assert.equal(second.ok ? null : second.reason, "same-project");
    assert.match(second.ok ? "" : second.error, /already running/i);
    runner.cancelAll();
    assert.equal(resultOf(await first).status, "cancelled");
  });

  test("16 GiB 机器：第二个项目明确拒绝（reason busy + 中文请稍后），不排队", async () => {
    const a = texProject([nodeExe, ...HANG]);
    const b = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { totalTimeoutMs: 30_000, totalMemoryBytes: 16 * 1024 ** 3 });
    const first = runner.compile({ dir: a });
    await sleep(300);
    const second = await runner.compile({ dir: b });
    assert.equal(second.ok, false, "低内存机不允许第二个编译开跑");
    assert.equal(second.ok ? null : second.reason, "busy");
    assert.match(second.ok ? "" : second.error, /at most 1 at a time/);
    assert.match(second.ok ? "" : second.error, /do not queue/);
    runner.cancelAll();
    assert.equal(resultOf(await first).status, "cancelled");
  });

  test(">16 GiB 机器：仍然同时跑 2 个，第三个被拒", async () => {
    const a = texProject([nodeExe, ...HANG]);
    const b = texProject([nodeExe, ...HANG]);
    const c = texProject([nodeExe, ...HANG]);
    const runner = new LatexRunner(probe(), { totalTimeoutMs: 30_000, totalMemoryBytes: 32 * 1024 ** 3 });
    const first = runner.compile({ dir: a });
    const second = runner.compile({ dir: b });
    await sleep(400);
    const third = await runner.compile({ dir: c });
    assert.equal(third.ok, false);
    assert.equal(third.ok ? null : third.reason, "busy");
    assert.match(third.ok ? "" : third.error, /at most 2 at a time/);
    runner.cancelAll();
    await Promise.all([first, second]);
  });
});

describe("latexMaxConcurrent —— 内存阀值边界", () => {
  test("16 GiB 是阀值：等于→1，多 1 字节→2；GB 与 GiB 的换算不能搞反", () => {
    const gib = 1024 ** 3;
    assert.equal(latexMaxConcurrent(16 * gib), 1, "标称 16 GB = 16 GiB，必须落进低内存档");
    assert.equal(latexMaxConcurrent(16 * gib + 1), 2);
    // 16 GB 机器 os.totalmem() 的典型报值：固件 / 内核保留掉一点，略小于 16 GiB
    assert.equal(latexMaxConcurrent(15.9 * gib), 1);
    assert.equal(latexMaxConcurrent(24 * gib), 2);
    assert.equal(latexMaxConcurrent(32 * gib), 2);
    // 十进制的 16 GB 当然也落在 ≤16 GiB 里（要是按 16e9 当阀值，16 GiB 机器反而会漏过）
    assert.equal(latexMaxConcurrent(16_000_000_000), 1);
  });

  test("默认值：idle 300 秒（90 秒已被实测证伪）、总时长 10 分钟", () => {
    assert.equal(LATEX_IDLE_TIMEOUT_MS, 300_000);
    assert.equal(LATEX_TOTAL_TIMEOUT_MS, 600_000);
    // 总时长闸必须比静默闸长，否则 idle 永远轮不到
    assert.ok(LATEX_TOTAL_TIMEOUT_MS > LATEX_IDLE_TIMEOUT_MS);
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

describe("LatexRunner —— 清理辅助文件", () => {
  test("没装 latexmk：如实拒绝，不 spawn", async () => {
    const dir = plainProject();
    const outcome = await new LatexRunner(probe(false)).clean(dir);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /not found/);
  });

  test("产物目录还不存在：空结果，不白跑一次 latexmk", async () => {
    const dir = plainProject();
    const outcome = await new LatexRunner(probe()).clean(dir);
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
    assert.deepEqual(outcome.ok ? outcome.result.removed : ["x"], []);
    assert.deepEqual(outcome.ok ? outcome.result.kept : ["x"], []);
    assert.equal(outcome.ok ? outcome.result.dir : "", join(resolve(dir), "build"));
  });

  test("正在编译时清理被拒（同一组 .aux 不能一边写一边删）", async () => {
    const dir = plainProject();
    fakeCompiler(dir, HANG);
    const runner = new LatexRunner(probe(), { idleTimeoutMs: 60_000, totalTimeoutMs: 60_000 });
    const compiling = runner.compile({ dir });
    await sleep(200);
    const outcome = await runner.clean(dir);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? undefined : outcome.reason, "same-project");
    runner.cancelAll();
    await withDeadline(compiling, 20_000, "取消后编译应当收尾");
  });
});

describe("清理的 argv 与差集（纯函数）", () => {
  test("argv 带 -c 与和编译一致的 -outdir", () => {
    assert.deepEqual(cleanArgv("/paper/build", "main.tex"), [
      "-c",
      "-interaction=nonstopmode",
      "-outdir=/paper/build",
      "main.tex",
    ]);
  });

  test("removed 是前后差集，kept 是清理后的磁盘事实（PDF 留在 kept 里）", () => {
    const result = cleanResult("/paper/build", ["main.aux", "main.log", "main.pdf"], ["main.pdf"], 42);
    assert.deepEqual(result.removed, ["main.aux", "main.log"]);
    assert.deepEqual(result.kept, ["main.pdf"]);
    assert.equal(result.durationMs, 42);
  });

  test("本来就没东西可清：removed 空，不是失败", () => {
    assert.deepEqual(cleanResult("/b", ["main.pdf"], ["main.pdf"], 1).removed, []);
  });
});
