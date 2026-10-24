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
  return {
    status: "ok",
    engine: "pdf",
    main: "main.tex",
    pdf: null,
    pdfFresh: false,
    pages: null,
    durationMs: 1200,
    errors: [],
    warnings: [],
    logStale: false,
    logTail: null,
    timeoutKind: null,
    ...overrides,
  };
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
      result: baseResult({ status: "ok", pages: 3, pdf: "/repo/paper/build/main.pdf", pdfFresh: true, logTail: null }),
    });
    assert.match(text, /succeeded/);
    assert.match(text, /3 pages/);
    assert.match(text, /PDF: \/repo\/paper\/build\/main\.pdf/);
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
        logTail: "! LaTeX Error: File `x.sty' not found.\n",
      }),
    });
    assert.match(text, /failed: status "compile-error"/);
    assert.match(text, /main\.tex:3 — ! LaTeX Error: File `x\.sty' not found\./);
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
        logTail: "log",
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
        logStale: true,
        pages: null,
        errors: [{ file: "main.tex", line: 4, message: "Missing $ inserted.", kind: "error" }],
        logTail: "stale log",
      }),
    });
    assert.match(text, /did not write a new \.log/);
    assert.match(text, /previous build/);
    assert.doesNotMatch(text, /pages/);
  });

  test("静默超时：说清是日志不再输出、被杀掉了，指向死循环", async () => {
    const text = await runTool({
      ok: true,
      result: baseResult({
        status: "timeout",
        timeoutKind: "idle",
        durationMs: 95_200,
        errors: [],
        logTail: null,
      }),
    });
    assert.match(text, /no new log output for 90 seconds/);
    assert.match(text, /killed after 95\.2s/);
    assert.match(text, /infinite loop/);
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
    assert.match(text, /total time limit/);
    assert.match(text, /split the document/);
    assert.doesNotMatch(text, /no new log output/);
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
