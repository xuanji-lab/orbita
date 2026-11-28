/**
 * export_docx 的工具层：只翻译参数、等回执、把产物交给右栏。
 * 失败时的前缀要能让模型分清「该改公式」还是「该装 pandoc」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createDocxExportTools, DOCX_EXPORT_TOOL_NAMES } from "./docx-export-tools.ts";
import type { DocxExportOutcome } from "../shared/docx-export.ts";

/** pi 的 execute 带 onUpdate / ExtensionContext；工具都不用，按三参调 */
type CallableTool = {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ content: unknown; details?: unknown }>;
};

interface Recorded {
  event: Record<string, unknown>;
  timeout: number | undefined;
}

function brokerOf(outcome: DocxExportOutcome): { broker: { request: <T>(event: Record<string, unknown>, timeout?: number) => Promise<T> }; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    broker: {
      request: <T,>(event: Record<string, unknown>, timeout?: number): Promise<T> => {
        recorded.push({ event, timeout });
        return Promise.resolve(outcome as T);
      },
    },
  };
}

function execute(tool: ReturnType<typeof createDocxExportTools>[number] | undefined, params: Record<string, unknown>) {
  assert.ok(tool !== undefined);
  return (tool as unknown as CallableTool).execute("call-1", params, undefined);
}

function executeWithSignal(
  tool: ReturnType<typeof createDocxExportTools>[number] | undefined,
  params: Record<string, unknown>,
  signal: AbortSignal,
) {
  assert.ok(tool !== undefined);
  return (tool as unknown as CallableTool).execute("call-1", params, signal);
}

const success: DocxExportOutcome = {
  ok: true,
  status: "ok",
  path: "/w/paper.docx",
  bytes: 2048,
  stats: {
    paragraphs: 10,
    headings: 2,
    tables: 1,
    numberedEquations: 3,
    threeLineTables: 1,
    fields: 5,
    coverSection: true,
    bytes: 2048,
  },
  warnings: [],
  template: {
    requested: "default",
    path: null,
    ok: true,
    verdict: "ok",
    problem: null,
    summary: { styles: 49, headerFooter: 2, macros: false, warnings: 0 },
    note: null,
    findings: [],
  },
  pandocPath: "pandoc",
  pandocVersion: "3.12.1",
  inputFormat: "markdown",
  lists: { toc: true, figures: false, tables: true },
};

describe("export_docx 工具", () => {
  test("注册名只有 export_docx", () => {
    assert.deepEqual([...DOCX_EXPORT_TOOL_NAMES], ["export_docx"]);
  });

  test("参数原样进 docxExportRequest，回执上限长于转换本身", async () => {
    const { broker, recorded } = brokerOf(success);
    const [tool] = createDocxExportTools(broker, "s1", { cwd: "/w" });
    assert.ok(tool);
    await execute(tool, { source: "paper.md", out: "paper.docx", template: "school.docx" });
    const request = recorded[0]?.event;
    assert.equal(request?.["type"], "docxExportRequest");
    assert.equal(request?.["sessionId"], "s1");
    assert.deepEqual(request?.["request"], { source: "paper.md", out: "paper.docx", template: "school.docx" });
    assert.ok((recorded[0]?.timeout ?? 0) > 300_000);
  });

  test("成功：摘要 + openPanel（强制切过去）+ 完成卡", async () => {
    const { broker } = brokerOf(success);
    const [tool] = createDocxExportTools(broker, "s1", { cwd: "/w" });
    const result = await execute(tool, { source: "paper.md", out: "paper.docx" });
    const blocks = Array.isArray(result.content) ? result.content : [];
    const first = blocks[0] as { type?: string; text?: string } | undefined;
    const text = first?.type === "text" ? (first.text ?? "") : "";
    assert.match(text, /\/w\/paper\.docx/);
    assert.match(text, /2 headings/);
    assert.match(text, /3 numbered equations/);
    assert.match(text, /table of contents/);
    const details = result.details as { openPanel?: { kind: string; path: string; force?: boolean }; card?: { kind: string; title: string } };
    assert.deepEqual(details.openPanel, { kind: "files", path: "/w/paper.docx", force: true });
    assert.equal(details.card?.kind, "export");
    assert.equal(details.card?.title, "paper.docx");
  });

  test("公式降级 → 抛 Formula gate 前缀（模型该改公式）", async () => {
    const { broker } = brokerOf({
      ok: false,
      code: "formula-degraded",
      error: "Unconverted math: `$\\foo$`.",
      warnings: [],
    });
    const [tool] = createDocxExportTools(broker, "s1", { cwd: "/w" });
    await assert.rejects(() => execute(tool, { source: "a.md", out: "a.docx" }), /Formula gate: Unconverted math/);
  });

  test("pandoc 太旧 → pandoc 前缀；普通失败 → Word export failed", async () => {
    const old = brokerOf({ ok: false, code: "pandoc-too-old", error: "needs 3.10.2", warnings: [] });
    const [tool] = createDocxExportTools(old.broker, "s1", { cwd: "/w" });
    await assert.rejects(() => execute(tool, { source: "a.md", out: "a.docx" }), /^Error: pandoc: needs 3\.10\.2$/);

    const failed = brokerOf({ ok: false, code: "pandoc-failed", error: "boom", warnings: ["[WARNING] x"] });
    const [tool2] = createDocxExportTools(failed.broker, "s1", { cwd: "/w" });
    await assert.rejects(() => execute(tool2, { source: "a.md", out: "a.docx" }), /Word export failed: boom[\s\S]*Warnings/);
  });

  test("LaTeX 表格降级 → 抛 Table gate 前缀（模型该改源文件）", async () => {
    const { broker } = brokerOf({
      ok: false,
      code: "table-degraded",
      error: "The source uses LaTeX table environment(s): \begin{tabular}.",
      warnings: [],
    });
    const [tool] = createDocxExportTools(broker, "s1", { cwd: "/w" });
    await assert.rejects(() => execute(tool, { source: "a.tex", out: "a.docx" }), /^Error: Table gate: /);
  });

  test("缺参数 / 已停止：不发明回执", async () => {
    const { broker, recorded } = brokerOf(success);
    const [tool] = createDocxExportTools(broker, "s1", { cwd: "/w" });
    await assert.rejects(() => execute(tool, { out: "a.docx" }), /"source" is required/);
    await assert.rejects(() => execute(tool, { source: "a.md" }), /"out" is required/);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(() => executeWithSignal(tool, { source: "a.md", out: "a.docx" }, aborted.signal), /Stopped/);
    assert.equal(recorded.length, 0);
  });
});
