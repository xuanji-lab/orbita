/**
 * Office 工具层：参数解析（模型最常拼错的地方）+ 给模型的正文。
 * broker 是假的——这里不跑 OfficeCLI，只钉「参数不对要说清第几项」「结果怎么讲」。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OfficeAgentOutcome } from "../shared/office.ts";
import { createOfficeTools, parseOfficeOps } from "./office-tools.ts";

interface Seen {
  event: Record<string, unknown>;
  timeoutMs: number | undefined;
}

function fakeBroker(outcome: OfficeAgentOutcome): { broker: { request: <T,>(event: Record<string, unknown>, timeoutMs?: number) => Promise<T> }; seen: Seen[] } {
  const seen: Seen[] = [];
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

type CallableTool = {
  name: string;
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined): Promise<{ content: { type: string; text: string }[] }>;
};

function tool(name: "read_office" | "edit_office", outcome: OfficeAgentOutcome) {
  const fake = fakeBroker(outcome);
  const tools = createOfficeTools(fake.broker, "s1", { cwd: "/ws" }) as unknown as CallableTool[];
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found !== undefined);
  return { tool: found, seen: fake.seen };
}

describe("parseOfficeOps", () => {
  test("合法操作：路径规范化、props 只收标量", () => {
    const parsed = parseOfficeOps([
      { op: "set", path: " /Sheet1/B2 ", props: { value: 42, bold: true, nested: { a: 1 } } },
      { op: "add", path: "/slide[1]", type: "textbox", props: { text: "Hi" } },
      { op: "remove", path: "/slide[2]/shape[@id=3]" },
    ]);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ops, [
      { op: "set", path: "/Sheet1/B2", props: { value: 42, bold: true } },
      { op: "add", path: "/slide[1]", type: "textbox", props: { text: "Hi" } },
      { op: "remove", path: "/slide[2]/shape[@id=3]" },
    ]);
  });

  test("错误指明第几项：op / path / type / props 各一条", () => {
    const badOp = parseOfficeOps([{ op: "patch", path: "/a" }]);
    assert.ok(!badOp.ok);
    assert.match(badOp.error, /ops\[0\]\.op/);

    const badPath = parseOfficeOps([{ op: "set", path: "Sheet1/B2", props: { value: 1 } }]);
    assert.ok(!badPath.ok);
    assert.match(badPath.error, /ops\[0\]\.path/);

    const noType = parseOfficeOps([{ op: "add", path: "/slide[1]", props: { text: "x" } }]);
    assert.ok(!noType.ok);
    assert.match(noType.error, /ops\[0\]\.type/);

    const noProps = parseOfficeOps([{ op: "set", path: "/Sheet1/B2" }]);
    assert.ok(!noProps.ok);
    assert.match(noProps.error, /ops\[0\]\.props/);
  });

  test("空表 / 过多 / 非数组都拒绝", () => {
    assert.ok(!parseOfficeOps([]).ok);
    assert.ok(!parseOfficeOps("nope").ok);
    const many = Array.from({ length: 41 }, () => ({ op: "set", path: "/Sheet1/A1", props: { value: 1 } }));
    const tooMany = parseOfficeOps(many);
    assert.ok(!tooMany.ok);
    assert.match(tooMany.error, /at most 40/);
  });
});

describe("read_office", () => {
  test("相对路径按会话 cwd 拼；node 默认 /、depth 默认 2", async () => {
    const { tool: read, seen } = tool("read_office", { ok: true, kind: "read", text: "/Sheet1\n/Sheet1/B2 (cell) 42" });
    const result = await read.execute("c1", { path: "book.xlsx" }, undefined);
    assert.match(result.content[0]?.text ?? "", /B2/);
    const request = seen[0]?.event["request"] as { kind: string; file: string; path?: string; depth?: number };
    assert.equal(request.kind, "read");
    assert.equal(request.file, "/ws/book.xlsx");
    assert.equal(request.path, "/");
    assert.equal(request.depth, 2);
    assert.equal(seen[0]?.timeoutMs, 240_000);
  });

  test("非 Office 扩展名 / 坏 node 直接拒绝，不发请求", async () => {
    const { tool: read, seen } = tool("read_office", { ok: true, kind: "read", text: "" });
    await assert.rejects(() => read.execute("c1", { path: "a.docx" }, undefined), /Only \.xlsx and \.pptx/);
    await assert.rejects(() => read.execute("c1", { path: "a.xlsx", node: "Sheet1" }, undefined), /\/-rooted/);
    assert.equal(seen.length, 0);
  });

  test("超长输出截断并告诉模型怎么缩小范围", async () => {
    const { tool: read } = tool("read_office", { ok: true, kind: "read", text: "x".repeat(25_000) });
    const result = await read.execute("c1", { path: "/ws/a.xlsx" }, undefined);
    const text = result.content[0]?.text ?? "";
    assert.equal(text.length < 21_000, true);
    assert.match(text, /truncated/);
  });
});

describe("edit_office", () => {
  test("成功：逐条列出 旧值 → 新值，并说改动能一键回退", async () => {
    const { tool: edit } = tool("edit_office", {
      ok: true,
      kind: "edit",
      file: "/ws/a.xlsx",
      version: "1.0.158",
      elapsedMs: 3200,
      items: [
        { id: "1:0", command: "set", path: "/Sheet1/B2", before: "42", after: "99" },
        { id: "1:1", command: "remove", path: "/Sheet1/C3", before: "x", after: null },
      ],
      failures: [{ path: "/Sheet1/D4", error: "not found" }],
      canRevert: true,
    });
    const result = await edit.execute("c1", { path: "/ws/a.xlsx", ops: [{ op: "set", path: "/Sheet1/B2", props: { value: 99 } }] }, undefined);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /2 change\(s\) in 3\.2s/);
    assert.match(text, /set \/Sheet1\/B2: 42 → 99/);
    assert.match(text, /remove \/Sheet1\/C3: x → ∅/);
    assert.match(text, /Failed \(not applied\): \/Sheet1\/D4 — not found/);
    assert.match(text, /one-click revert/);
  });

  test("没有备份就明说不能回退（不假装能撤回）", async () => {
    const { tool: edit } = tool("edit_office", {
      ok: true,
      kind: "edit",
      file: "/ws/a.xlsx",
      version: "1",
      elapsedMs: 10,
      items: [{ id: "1:0", command: "set", path: "/Sheet1/B2", before: null, after: "1" }],
      failures: [],
      canRevert: false,
    });
    const result = await edit.execute("c1", { path: "/ws/a.xlsx", ops: [{ op: "set", path: "/Sheet1/B2", props: { value: 1 } }] }, undefined);
    assert.match(result.content[0]?.text ?? "", /cannot revert/);
  });

  test("主进程拒绝（atomic 未落盘）：错误原样抛出给模型", async () => {
    const { tool: edit } = tool("edit_office", { ok: false, error: "OfficeCLI rejected the batch, so nothing was written (atomic). #1: not found" });
    await assert.rejects(
      () => edit.execute("c1", { path: "/ws/a.xlsx", ops: [{ op: "set", path: "/Sheet1/B2", props: { value: 1 } }] }, undefined),
      /nothing was written/,
    );
  });

  test("坏 ops 在本地就拦住，不发请求", async () => {
    const { tool: edit, seen } = tool("edit_office", { ok: false, error: "x" });
    await assert.rejects(() => edit.execute("c1", { path: "/ws/a.xlsx", ops: [] }, undefined), /non-empty/);
    assert.equal(seen.length, 0);
  });
});
