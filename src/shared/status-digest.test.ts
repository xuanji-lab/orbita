/**
 * 状态卡摘要 fold 的单测（shared/status-digest.ts）：正常增量、各段的折叠语义、
 * 与旧派生的逐项对照在 status-digest-equivalence.test.ts（renderer，合成夹具）与
 * scripts/status-digest-audit.test.mjs（真实会话）里。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "./session.ts";
import {
  digestChildActivity,
  digestOutputs,
  digestTerminals,
  emptyStatusDigestState,
  foldStatusRecord,
  foldStatusRecords,
  parseStatusDigestState,
  slimRecordOf,
} from "./status-digest.ts";

let seq = 0;
const id = () => `r${++seq}`;

function user(text: string, at = 1): TranscriptRecord {
  return { role: "user", id: id(), timestamp: at, content: [{ type: "text", text }] } as unknown as TranscriptRecord;
}
function assistant(blocks: unknown[], at = 2): TranscriptRecord {
  return { role: "assistant", id: id(), timestamp: at, content: blocks, status: "complete" } as unknown as TranscriptRecord;
}
function toolCall(toolCallId: string, toolName: string, input: unknown): unknown {
  return { type: "toolCall", toolCallId, toolName, input };
}
function textBlock(text: string): unknown {
  return { type: "text", text };
}
function tool(toolCallId: string, toolName: string, status: "running" | "complete" | "error", at = 3, extra: Record<string, unknown> = {}): TranscriptRecord {
  return {
    role: "tool",
    id: id(),
    toolCallId,
    toolName,
    input: {},
    content: [],
    timestamp: at,
    status,
    isError: status === "error",
    ...extra,
  } as unknown as TranscriptRecord;
}
function fileTurn(changes: string[], at = 4, extra: Record<string, unknown> = {}): TranscriptRecord {
  return {
    role: "file-turn",
    id: id(),
    timestamp: at,
    changes: changes.map((path) => ({ path, added: 1, removed: 0 })),
    ...extra,
  } as unknown as TranscriptRecord;
}

describe("状态卡摘要：指纹", () => {
  it("空会话：lastId null、0 条", () => {
    const state = emptyStatusDigestState();
    assert.equal(state.meta.lastId, null);
    assert.equal(state.meta.records, 0);
  });
  it("每条记录推进 lastId / lastTs / records / recentIds（含 undo 空操作记录）", () => {
    const u = user("你好", 10);
    const t = tool("c1", "read", "complete", 20);
    const state = foldStatusRecords([u, t, { role: "undo", id: "u1", timestamp: 30 } as unknown as TranscriptRecord]);
    assert.equal(state.meta.records, 3);
    assert.equal(state.meta.lastId, "u1");
    assert.equal(state.meta.lastTs, 30);
    assert.deepEqual(state.meta.recentIds, [u.id, t.id, "u1"]);
  });
});

describe("状态卡摘要：子会话在跑什么（activity）", () => {
  it("assistant 发出调用、结果没来 = 在跑那个调用", () => {
    const state = foldStatusRecords([user("干活"), assistant([toolCall("c1", "bash", { command: "sleep 900" })])]);
    assert.deepEqual(digestChildActivity(state), { toolName: "bash", input: { command: "sleep 900" }, since: 2 });
  });
  it("结果到了 = 不在跑；user 来了 = 清空", () => {
    const state = foldStatusRecords([user("干活"), assistant([toolCall("c1", "bash", {})]), tool("c1", "bash", "complete")]);
    assert.equal(digestChildActivity(state), null);
    const state2 = foldStatusRecords([assistant([toolCall("c1", "bash", {})]), user("停")]);
    assert.equal(digestChildActivity(state2), null);
  });
  it("running 工具记录优先；同 callId 之后来了终态仍报 running（batch 的 quirk）", () => {
    const state = foldStatusRecords([assistant([toolCall("c1", "bash", { command: "x" })]), tool("c1", "bash", "running", 5, { input: { command: "x" } }), tool("c1", "bash", "complete", 6)]);
    assert.deepEqual(digestChildActivity(state), { toolName: "bash", input: { command: "x" }, since: 5 });
  });
  it("新一条 assistant  supersede：它的调用成为 pending，running 清空", () => {
    const state = foldStatusRecords([
      assistant([toolCall("c1", "bash", {})], 2),
      tool("c1", "bash", "running", 3),
      assistant([toolCall("c2", "read", { path: "/a/b.ts" })], 4),
    ]);
    assert.deepEqual(digestChildActivity(state), { toolName: "read", input: { path: "/a/b.ts" }, since: 4 });
  });
  it("input 只留 toolCallLine 读的六个键", () => {
    const state = foldStatusRecords([assistant([toolCall("c1", "write", { path: "/a/b.md", content: "x".repeat(5000) })])]);
    assert.deepEqual(digestChildActivity(state)?.input, { path: "/a/b.md" });
  });
});

describe("状态卡摘要：终端", () => {
  it("terminal_execute 完成结果里抽出 id 与命令；同 id 覆盖", () => {
    const state = foldStatusRecords([
      tool("c1", "terminal_execute", "complete", 5, { input: { command: "bun run dev" }, content: [{ type: "text", text: "opened visible terminal term-1 (zsh)" }] }),
      tool("c2", "terminal_execute", "complete", 6, { input: { command: "bun test" }, content: [{ type: "text", text: "opened visible terminal term-1 (zsh)" }] }),
    ]);
    assert.deepEqual(digestTerminals(state), [{ id: "term-1", command: "bun test", since: 6 }]);
  });
});

describe("状态卡摘要：产物", () => {
  it("slides_create + slides_write：页数取最后一次写的结果", () => {
    const state = foldStatusRecords([
      assistant([toolCall("c1", "slides_create", { title: "汇报" })]),
      tool("c1", "slides_create", "complete", 3, { details: { card: { kind: "slides", path: "/w/汇报.slides.json", title: "汇报" } } }),
      assistant([toolCall("c2", "slides_write", { path: "/w/汇报.slides.json" })]),
      tool("c2", "slides_write", "complete", 4, { content: [{ type: "text", text: "ok, the deck now has 5 slide(s)" }] }),
    ]);
    const outputs = digestOutputs(state);
    assert.equal(outputs.length, 1);
    assert.deepEqual(outputs[0], { kind: "slides", path: "/w/汇报.slides.json", title: "汇报", pages: 5, by: null, at: 4, plugin: null, boardCall: null });
  });
  it("导出的 PNG 是自检不算产物；PDF 导出算", () => {
    const state = foldStatusRecords([
      assistant([toolCall("c1", "slides_export", { path: "/w/a.slides.json", format: "png" })]),
      tool("c1", "slides_export", "complete", 3, { details: { card: { kind: "export", path: "/w/a.png", title: "a" } } }),
      assistant([toolCall("c2", "slides_export", { path: "/w/a.slides.json", format: "pdf" })]),
      tool("c2", "slides_export", "complete", 4, { details: { card: { kind: "export", path: "/w/a.pdf", title: "a", subtitle: "PDF · 3 页" } } }),
    ]);
    const outputs = digestOutputs(state);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.kind, "pdf");
    assert.equal(outputs[0]?.path, "/w/a.pdf");
  });
  it("文件账里写出、最终回答点了名的网页进产物；没点名的进 edited（图片再进产物）", () => {
    const state = foldStatusRecords([
      user("写个页面"),
      assistant([textBlock("写好了 /w/page.html，顺手生成了 /w/chart.png")]),
      fileTurn(["/w/page.html", "/w/chart.png", "/w/notes.txt"], 5),
    ]);
    const outputs = digestOutputs(state);
    // page.html 点了名（web）；chart.png 点了名但不是文档/网页候选——它是图片，从 edited 进；notes.txt 没点名、不是图片，不进
    const paths = outputs.map((o) => o.path);
    assert.ok(paths.includes("/w/page.html"));
    assert.ok(paths.includes("/w/chart.png"));
    assert.ok(!paths.includes("/w/notes.txt"));
  });
  it("正文段被 thinking / 工具调用打断后，file-turn 只点打断之后那段", () => {
    const state = foldStatusRecords([
      assistant([textBlock("先说 /w/a.html")]),
      assistant([toolCall("c1", "bash", { command: "ls" })]),
      tool("c1", "bash", "complete"),
      assistant([textBlock("再看 /w/b.html")]),
      fileTurn(["/w/a.html", "/w/b.html"], 6),
    ]);
    const paths = digestOutputs(state).map((o) => o.path);
    assert.ok(!paths.includes("/w/a.html"), "打断前的 a.html 不该被点名");
    assert.ok(paths.includes("/w/b.html"));
  });
  it("看板：同名只留最后一次成功的", () => {
    const board = (title: string) => ({ pluginBoard: { plugin: "p1", displayName: "P1", title, source: "installed", at: 1, cards: [] } });
    const state = foldStatusRecords([
      tool("c1", "show_plugin_board", "complete", 5, { details: board("看板A") }),
      tool("c2", "show_plugin_board", "complete", 6, { details: board("看板A") }),
    ]);
    const outputs = digestOutputs(state);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.kind, "board");
    assert.equal(outputs[0]?.at, 6);
    assert.equal(outputs[0]?.boardCall?.toolCallId, "c2");
  });
  it("结果没来的调用不算产物（batch：result undefined 跳过）", () => {
    const state = foldStatusRecords([assistant([toolCall("c1", "slides_create", { title: "x" })])]);
    assert.equal(digestOutputs(state).length, 0);
  });
});

describe("状态卡摘要：slim 段（goal / plan / delegation 的输入）", () => {
  it("user 只留 headLine（首行 60 字）；channel-mark 整条留", () => {
    const long = `${"很".repeat(100)}\n第二行`;
    const state = foldStatusRecords([user(long), { role: "channel-mark", id: "m1", timestamp: 2, peerId: "p", messageId: "m", from: "child", kind: "report" } as unknown as TranscriptRecord]);
    assert.equal(state.slim.length, 2);
    const first = state.slim[0];
    assert.equal(first?.role, "user");
    assert.equal((first as { content: { text: string }[] }).content[0]?.text.length, 60);
    assert.equal(state.slim[1]?.role, "channel-mark");
  });
  it("update_plan / update_goal / delegate 留 slim；别的工具不留", () => {
    const state = foldStatusRecords([
      tool("c1", "update_plan", "complete", 3, { input: { items: [{ text: "一步", status: "in_progress" }] } }),
      tool("c2", "update_goal", "complete", 4, { input: { goal: "目标" } }),
      tool("c3", "delegate", "complete", 5, { input: { title: "子任务", planStep: "一步" }, details: { delegate: { childId: "child-1" } } }),
      tool("c4", "read", "complete", 6, { input: { path: "/a" } }),
    ]);
    assert.deepEqual(state.slim.map((r) => (r.role === "tool" ? r.toolName : r.role)), ["update_plan", "update_goal", "delegate"]);
    const delegate = state.slim[2];
    assert.equal(delegate?.role === "tool" ? (delegate.details as { delegate: { childId: string } }).delegate.childId : null, "child-1");
  });
  it("slimRecordOf：delegate 没有 childId = null（batch 也跳过）", () => {
    assert.equal(slimRecordOf(tool("c1", "delegate", "complete", 3, { input: { title: "x" } })), null);
  });
});

describe("状态卡摘要：落盘形状校验", () => {
  it("好状态 round-trip；坏形状 = null", () => {
    const state = foldStatusRecords([user("你好")]);
    const parsed = parseStatusDigestState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(parsed, state);
    assert.equal(parseStatusDigestState(null), null);
    assert.equal(parseStatusDigestState({ meta: { lastId: 1 } }), null);
    assert.equal(parseStatusDigestState({ meta: { lastId: null, lastTs: 0, records: 0, recentIds: [] }, slim: [], outputs: {}, activity: { pending: [], running: null }, terminals: [] }), null);
  });
});
