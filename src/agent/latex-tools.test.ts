/**
 * compile_latex 的结果文案 —— 模型唯一看得见的东西。
 *
 * 这里不测编译：runner/broker 都是假的。测的是「状态 → 该对模型说什么」：
 * 成功给摘要与页数、失败给 file:line、超时说清被杀了、旧 PDF 不许被叫成「本次产出」
 * （评审 M4），以及两万字的日志尾巴只在失败时出现。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LatexResult, LatexRunOutcome } from "../shared/latex.ts";
import { createLatexTools, type LatexToolBroker } from "./latex-tools.ts";

interface SeenRequest {
  event: Record<string, unknown>;
  timeoutMs: number | undefined;
}

function fakeBroker(outcome: LatexRunOutcome): { broker: LatexToolBroker; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  return {
    seen,
    broker: {
      request: async <T,>(event: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
        seen.push({ event, timeoutMs });
        return outcome as T;
      },
    },
  };
}

function baseResult(overrides: Partial<LatexResult>): LatexResult {
  const merged: LatexResult = {
    status: "ok",
    engine: "pdf",
    engineSource: "auto",
    root: null,
    command: null,
    steps: [],
    diagnostics: [],
    omitted: { errors: 0, warnings: 0, layout: 0 },
    outputs: [],
    outputsTruncated: false,
    candidates: [],
    log: null,
    main: "main.tex",
    pdf: null,
    pdfFresh: false,
    pages: null,
    durationMs: 1200,
    errors: [],
    warnings: [],
    logTail: null,
    timeoutKind: null,
    ...overrides,
  };
  // 生产里 diagnostics 是真源、errors/warnings 是镜像（run.ts 建）。测试只写镜像时
  // 在这里补一份，免得每条用例都列两遍。
  if (overrides.diagnostics === undefined) {
    merged.diagnostics = [...merged.errors, ...merged.warnings];
  }
  return merged;
}

function tail(text: string): { text: string; fromLine: number; truncated: boolean } {
  return { text, fromLine: 1, truncated: false };
}

/** pi 的 execute 还带 onUpdate / ExtensionContext；latex-tools 两个都不用，按三参调 */
type CallableTool = {
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined): Promise<{ content: unknown }>;
};

function execute(tool: ReturnType<typeof createLatexTools>[number], params: Record<string, unknown>) {
  assert.ok(tool !== undefined);
  return (tool as unknown as CallableTool).execute("call-1", params, undefined);
}

/** 跑一次工具，取回给模型的正文 */
async function runTool(outcome: LatexRunOutcome, params: Record<string, unknown> = {}): Promise<string> {
  const { broker } = fakeBroker(outcome);
  const [tool] = createLatexTools(broker, "session-1", { cwd: "/repo/paper" });
  assert.ok(tool !== undefined);
  const out = await execute(tool, params);
  const blocks = Array.isArray(out.content) ? out.content : [];
  const first = blocks[0] as { type?: string; text?: string } | undefined;
  return first?.text ?? "";
}

describe("compile_latex —— 请求形状", () => {
  test("参数原样转成 latexRequest，等回执的上限长于编译本身", async () => {
    const { broker, seen } = fakeBroker({ ok: true, result: baseResult({}) });
    const [tool] = createLatexTools(broker, "session-1", { cwd: "/repo/paper" });
    assert.ok(tool !== undefined);
    await execute(tool, { dir: "chapters", main: "one.tex", engine: "xelatex" });
    const request = seen[0];
    assert.ok(request !== undefined);
    assert.equal(request.event["type"], "latexRequest");
    assert.equal(request.event["sessionId"], "session-1");
    assert.deepEqual(request.event["request"], { dir: "chapters", main: "one.tex", engine: "xelatex" });
    // 默认 30 秒的回执上限会在第 31 秒诈称失败，而编译硬上限是 120 秒
    assert.ok((request.timeoutMs ?? 0) > 120_000, `回执上限只有 ${request.timeoutMs}ms`);
  });

  test("坏 engine 当场拒绝，不发请求", async () => {
    const { broker, seen } = fakeBroker({ ok: true, result: baseResult({}) });
    const [tool] = createLatexTools(broker, "session-1", { cwd: "/repo/paper" });
    assert.ok(tool !== undefined);
    await assert.rejects(() => execute(tool, { engine: "pdflatex" }), /engine must be one of/);
    assert.equal(seen.length, 0);
  });
});

describe("compile_latex —— 成功", () => {
  test("摘要带状态、页数、PDF 路径；不带日志尾巴", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "ok",
        pages: 3,
        pdf: "/repo/paper/build/main.pdf",
        pdfFresh: true,
        logTail: null,
        root: {
          path: "main.tex",
          source: "config",
          declaredBy: null,
          engine: "pdf",
          engineSource: "config",
          outDir: "/repo/paper/build",
          outDirRelative: "build",
          jobname: null,
        },
        outputs: [
          {
            path: "/repo/paper/build/main.pdf",
            kind: "pdf",
            primary: true,
            fresh: true,
            pages: 3,
            bytes: 1234,
            modifiedAt: 1,
            fromLog: "build/main.pdf",
          },
        ],
      }),
    });
    assert.match(text, /succeeded/);
    assert.match(text, /root main\.tex \(from config \(main\)\)/);
    assert.match(text, /3 pages/);
    assert.match(text, /Outputs \(1, primary first\)/);
    assert.match(text, /\/repo\/paper\/build\/main\.pdf — primary, 3 pages/);
    assert.doesNotMatch(text, /Log tail/);
  });

  test("warning-only 仍然算成功", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "warning-only",
        pages: 1,
        pdf: "/repo/paper/build/main.pdf",
        pdfFresh: true,
        warnings: [{ file: "main.tex", line: 9, message: "LaTeX Warning: Reference `x' undefined.", kind: "warning" }],
      }),
    });
    assert.match(text, /status "warning-only"/);
    assert.match(text, /main\.tex:9/);
  });
});

describe("compile_latex —— 失败", () => {
  test("缺包：file:line 与日志尾巴都进正文；旧 PDF 被叫成 earlier build", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "compile-error",
        pdf: "/repo/paper/build/main.pdf",
        pdfFresh: false,
        errors: [{ file: "main.tex", line: 3, message: "! LaTeX Error: File `x.sty' not found.", kind: "error" }],
        logTail: tail("! LaTeX Error: File `x.sty' not found.\n"),
      }),
    });
    assert.match(text, /failed: status "compile-error"/);
    assert.match(text, /main\.tex:3 /);
    assert.match(text, /! LaTeX Error: File `x\.sty' not found\./);
    assert.match(text, /A PDF from an earlier build is still on disk/);
    assert.doesNotMatch(text, /A PDF from this run exists/);
    assert.match(text, /Log tail/);
  });

  test("本次写出的 PDF（pdfFresh）：才说 from this run", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "compile-error",
        pdf: "/repo/paper/build/main.pdf",
        pdfFresh: true,
        errors: [{ file: "main.tex", line: 4, message: "Missing $ inserted.", kind: "error" }],
        logTail: tail("log"),
      }),
    });
    assert.match(text, /A PDF from this run exists/);
    assert.doesNotMatch(text, /earlier build/);
  });

  test("stale 日志：文案说清证据来自上一轮，且不报页数", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "compile-error",
        log: { path: "/repo/paper/build/main.log", bytes: 100, lines: 2, fresh: false, modifiedAt: 1, parseTruncated: false },
        pages: null,
        errors: [{ file: "main.tex", line: 4, message: "Missing $ inserted.", kind: "error" }],
        logTail: tail("stale log"),
      }),
    });
    assert.match(text, /did not write a new \.log/);
    assert.match(text, /previous build/);
    assert.doesNotMatch(text, /pages/);
  });

  test("静默超时：说清是日志不再输出、被杀掉了；不断言死循环", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "timeout",
        timeoutKind: "idle",
        durationMs: 305_200,
        errors: [],
        logTail: null,
      }),
    });
    assert.match(text, /no new log output for 300 seconds/);
    assert.match(text, /killed after 305\.2s/);
    assert.match(text, /long computation/);
  });

  test("总时长封顶：与静默卡住的下一步不同（拆文档 / 等机器空闲）", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "timeout",
        timeoutKind: "total",
        durationMs: 600_000,
        errors: [],
        logTail: null,
      }),
    });
    assert.match(text, /total time limit \(10 minutes\)/);
    assert.match(text, /split it into smaller parts/);
    // 不再断言“它一直在写日志”（日志可能根本不存在）
    assert.doesNotMatch(text, /still writing log output/);
    assert.doesNotMatch(text, /no new log output/);
  });

  test("并发被拒（reason busy）：明确告诉模型“稍后重试、不要排队”", async () => {
    await assert.rejects(
      () =>
        runTool({
          ok: false,
          reason: "busy",
          error: "LaTeX is busy: 1 build(s) already running on this machine (16.0 GiB total, so at most 1 at a time).",
        }),
      /LaTeX is busy .*wait for it to finish, do not queue/i,
    );
  });

  test("参数 / 授权失败（无 reason）：提示改请求，而不是“忙”", async () => {
    await assert.rejects(
      () => runTool({ ok: false, error: "dir must be inside the session's authorized directories." }),
      (error: Error) => {
        assert.match(error.message, /request rejected/i);
        assert.match(error.message, /fix the arguments/i);
        assert.doesNotMatch(error.message, /is busy/i);
        return true;
      },
    );
  });

  test("未安装：给出安装建议，不排错列表", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "not-installed",
        main: "",
        errors: [{ file: null, line: null, message: "latexmk was not found.", kind: "error" }],
      }),
    });
    assert.match(text, /latexmk is not installed/);
  });
});

describe("compile_latex —— 回执 v2 的形状", () => {
  const base = {
    status: "compile-error" as const,
    command: { executable: "latexmk", args: ["-xelatex", "-file-line-error", "main.tex"], source: "default" as const, cwd: "/repo/paper" },
    steps: [
      { rule: "xelatex", run: 1, startedAtMs: 0, durationMs: 800, end: "ran" as const },
      { rule: "bibtex", run: 2, startedAtMs: 800, durationMs: 300, end: "ran" as const },
      { rule: "xelatex", run: 3, startedAtMs: 1100, durationMs: 2000, end: "last" as const },
    ],
    log: { path: "/repo/paper/build/main.log", bytes: 319_488, lines: 5120, fresh: true, modifiedAt: 1_700_000_000_000, parseTruncated: false },
  };

  test("Command / Steps / Log 路径都在正文里", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        ...base,
        errors: [
          {
            file: "main.tex",
            line: 4,
            kind: "error",
            message: "Package fontspec Error: The font \"NoSuchFontAvailable\" cannot be found.",
            code: "font-missing",
            source: "log",
            step: "xelatex",
            raw: "l.4 \begin",
          },
        ],
      }),
    });
    assert.match(text, /Command: latexmk -xelatex -file-line-error main\.tex {2}\[default recipe\] \(cwd \/repo\/paper\)/);
    assert.match(text, /Steps: xelatex 0\.8s -> bibtex 0\.3s -> xelatex 2\.0s \(last\)/);
    assert.match(text, /Log: \/repo\/paper\/build\/main\.log — 312\.0 KB, 5120 lines, written by this run/);
    assert.match(text, /\[font-missing, log\/xelatex\]/);
    assert.match(text, /raw: l\.4/);
    assert.match(text, /The font "NoSuchFontAvailable" cannot be found/);
  });

  test("日志被解析器截断时明说（不许静默）", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        ...base,
        log: { ...base.log, parseTruncated: true },
        errors: [{ file: "main.tex", line: 1, kind: "error", message: "boom" }],
      }),
    });
    assert.match(text, /only its last part was parsed/);
  });

  test(".blg 诊断与 log 诊断同列，来源可辨", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        ...base,
        errors: [
          {
            file: "refs.bib",
            line: 5,
            kind: "error",
            message: "Illegal end of database file---line 5 of file refs.bib",
            code: "bib-error",
            source: "blg",
            step: "bibtex",
            raw: "Illegal end of database file---line 5 of file refs.bib",
          },
        ],
      }),
    });
    assert.match(text, /refs\.bib:5 {2}\[bib-error, blg\/bibtex\]/);
    assert.match(text, /Illegal end of database file/);
  });
});

describe("compile_latex —— token 预算", () => {
  test("超长回执按固定顺序砍：尾巴 → raw → layout → 产物；状态行 / Command / Log / 首条 error 永不砍", async () => {
    const errors = Array.from({ length: 20 }, (_, index) => ({
      file: "main.tex",
      line: index + 1,
      kind: "error" as const,
      message: `error ${String(index)} ${"x".repeat(200)}`,
      code: "other" as const,
      source: "log" as const,
      raw: `l.${String(index + 1)} ${"y".repeat(400)}`,
    }));
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "compile-error",
        command: { executable: "latexmk", args: ["-pdf", "main.tex"], source: "default", cwd: "/repo/paper" },
        log: { path: "/repo/paper/build/main.log", bytes: 400_000, lines: 9000, fresh: true, modifiedAt: 1, parseTruncated: false },
        errors,
        diagnostics: [
          ...errors,
          ...Array.from({ length: 40 }, (_, index) => ({
            file: "main.tex",
            line: 100 + index,
            kind: "layout" as const,
            message: `Overfull \hbox (1.0pt too wide) at lines ${String(100 + index)}--${String(101 + index)}`,
          })),
        ],
        outputs: Array.from({ length: 10 }, (_, index) => ({
          path: `/repo/paper/build/main-${String(index)}.pdf`,
          kind: "pdf" as const,
          primary: index === 0,
          fresh: true,
          pages: 12,
          bytes: 1000,
          modifiedAt: 1,
          fromLog: null,
        })),
        logTail: { text: "z".repeat(40_000), fromLine: 4000, truncated: true },
      }),
    });
    assert.ok(text.length <= 12_000, `正文 ${text.length} 字符，超过预算`);
    // 永不砍的四件事
    assert.match(text, /LaTeX build failed: status "compile-error"/);
    assert.match(text, /Command: latexmk -pdf main\.tex/);
    assert.match(text, /Log: \/repo\/paper\/build\/main\.log/);
    assert.match(text, /error 0 /);
    // 砍的顺序：尾巴 → raw（两条都超出预算，这两样必须已经不在）
    assert.doesNotMatch(text, /Log tail/);
    assert.doesNotMatch(text, /raw:/);
  });
});

describe("latex_packages", () => {
  test("描述文件 → 包名与安装命令；not-found 不猜命令", async () => {
    const seen: Record<string, unknown>[] = [];
    const broker: LatexToolBroker = {
      request: async <T,>(event: Record<string, unknown>): Promise<T> => {
        seen.push(event);
        return {
          ok: true,
          resolved: [
            {
              missing: "ctexart.cls",
              packageName: "ctex",
              command: "tlmgr install ctex",
              sudo: false,
              installed: false,
              distro: "texlive",
              reason: null,
            },
            {
              missing: "not-a-real-pkg.sty",
              packageName: null,
              command: null,
              sudo: false,
              installed: false,
              distro: "texlive",
              reason: "not-found",
            },
          ],
        } as T;
      },
    };
    const tools = createLatexTools(broker, "session-1", { cwd: "/repo/paper" });
    const tool = tools.find((entry) => entry.name === "latex_packages");
    assert.ok(tool !== undefined, "latex_packages 没有注册");
    const out = await execute(tool, { missing: ["ctexart.cls", "not-a-real-pkg.sty"] });
    const blocks = Array.isArray(out.content) ? out.content : [];
    const body = (blocks[0] as { text?: string } | undefined)?.text ?? "";

    assert.equal(seen[0]?.["type"], "latexPackageRequest");
    assert.deepEqual(seen[0]?.["missing"], ["ctexart.cls", "not-a-real-pkg.sty"]);
    assert.match(body, /ctexart\.cls -> ctex \(texlive, not installed\)/);
    assert.match(body, /run: tlmgr install ctex/);
    assert.match(body, /not-a-real-pkg\.sty -> unknown \(texlive, not-found\)/);
    assert.doesNotMatch(body, /tlmgr install not-a-real-pkg/);
  });

  test("缺 missing 参数：当场拒绝，不发请求", async () => {
    const { broker, seen } = fakeBroker({ ok: true, result: baseResult({}) });
    const tool = createLatexTools(broker, "session-1", { cwd: "/repo/paper" }).find((entry) => entry.name === "latex_packages");
    assert.ok(tool !== undefined);
    await assert.rejects(() => execute(tool, { missing: [] }), /missing is required/);
    assert.equal(seen.length, 0);
  });
});
