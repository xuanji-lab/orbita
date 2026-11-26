import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionRecord } from "../../shared/session.ts";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { SessionStore } from "../session/store.ts";
import { MobileTails } from "./tails.ts";

const ID = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";
let dir = "";
let log = "";
let store: SessionStore;
let tails: MobileTails;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-mobile-tails-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  log = join(dir, "sessions", `${ID}.jsonl`);
  store = new SessionStore(join(dir, "sessions"));
  tails = new MobileTails({ tailWindow: (id, options) => store.tailWindow(id, options), tailStat: (id) => store.tailStat(id) });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const user = (id: string, text = "问"): Extract<TranscriptItem, { role: "user" }> => ({ id, role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (id: string, text = "答", toolCalls = 0): Exclude<Extract<TranscriptItem, { role: "assistant" }>, { status: "streaming" }> => ({
  id,
  role: "assistant",
  timestamp: 1,
  status: "complete",
  stopReason: toolCalls > 0 ? "toolUse" : "stop",
  model: { provider: "p", id: "m" },
  content: [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...Array.from({ length: toolCalls }, (_, index) => ({ type: "toolCall" as const, toolCallId: `${id}-${index}`, toolName: "bash", input: {} })),
  ],
});
const tool = (id: string, output = "ok"): ToolTranscriptItem => ({
  id,
  role: "tool",
  toolCallId: id,
  toolName: "bash",
  input: {},
  content: [{ type: "text", text: output }],
  status: "complete",
  isError: false,
  timestamp: 1,
});
const put = async (records: readonly SessionRecord[]): Promise<void> => {
  await writeFile(log, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
};
const waitFlush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

describe("手机尾部分页（真实 JSONL）", () => {
  test("文件不存在是空页；首页 rev 是文件字节数", async () => {
    assert.deepEqual(await tails.load(ID), { entries: [], hasMore: false, rev: 0 });
    await put([user("u1"), assistant("a1")]);
    const page = await tails.load(ID);
    assert.ok(page);
    assert.deepEqual(page.entries.map((entry) => entry.id), ["u1", "a1"]);
    assert.equal(page.rev, (await store.tailStat(ID))?.size);
    assert.equal(page.hasMore, false);
    assert.equal(tails.revOf(ID), page.rev);
  });

  test("180 条跨多个窗口：每页 60 条，before 不重叠、不回空页", async () => {
    const records = Array.from({ length: 180 }, (_, index) => user(`u${index}`, `第 ${index} 条 ${"内容".repeat(300)}`));
    await put(records);
    const first = await tails.load(ID);
    assert.ok(first);
    assert.equal(first.entries.length, 60);
    assert.equal(first.entries[0]?.id, "u120");
    assert.equal(first.hasMore, true);
    const second = await tails.load(ID, first.entries[0]?.id);
    assert.ok(second);
    assert.equal(second.entries.length, 60);
    assert.equal(second.entries[0]?.id, "u60");
    assert.equal(second.entries.at(-1)?.id, "u119");
    const third = await tails.load(ID, second.entries[0]?.id);
    assert.ok(third);
    assert.equal(third.entries.length, 60);
    assert.equal(third.entries[0]?.id, "u0");
    assert.equal(third.hasMore, false);
    assert.equal(await tails.load(ID, "不存在的锚点"), null);
  });

  test("工具调用串跨窗口仍折成一条 process；回退后的旧对话不给", async () => {
    const calls = Array.from({ length: 10 }, (_, index) => tool(`t${index}`, "x".repeat(35_000)));
    await put([user("u1"), assistant("a1", "", 10), ...calls, assistant("a2", "做完了")]);
    const page = await tails.load(ID);
    assert.ok(page);
    assert.deepEqual(
      page.entries.map((entry) => [entry.kind, entry.id, entry.steps]),
      [["user", "u1", undefined], ["process", "t9", 10], ["assistant", "a2", undefined]],
    );

    await put([
      user("old"),
      assistant("old-answer", "已经撤回的话"),
      { role: "revert", id: "revert-1", targetMessageId: "old", restored: [], timestamp: 2 },
      user("new", "重新问"),
      assistant("new-answer", "新回答"),
    ]);
    const effective = await tails.load(ID);
    assert.ok(effective);
    assert.deepEqual(effective.entries.map((entry) => entry.id), ["new", "new-answer"]);
  });
});

describe("tail.changed：只对真正落盘的尾部变化推新 rev", () => {
  test("title / stats 不造 rev；终态记录后按文件大小推；重复事件不重复推", async () => {
    await put([user("u1")]);
    const initial = await tails.load(ID);
    assert.ok(initial);
    const pushes: number[] = [];
    const unwatch = tails.watch(ID, (_id, rev) => pushes.push(rev));

    tails.onAgentEvent({ type: "title", sessionId: ID, title: "改名" });
    await waitFlush();
    assert.deepEqual(pushes, []);
    const appended = assistant("a1", "新回答");
    await appendFile(log, `${JSON.stringify(appended)}\n`);
    // stats 本身不是转录记录：即使文件恰好变了，也只标脏由终态事件负责，避免无 record 的 stats 推空变化
    tails.onAgentEvent({ type: "stats", sessionId: ID, stats: {} } as AgentEvent);
    await waitFlush();
    assert.deepEqual(pushes, []);

    tails.onAgentEvent({ type: "progress", sessionId: ID, progress: { type: "item_finished", item: appended } });
    await waitFlush();
    assert.deepEqual(pushes, [(await store.tailStat(ID))?.size]);
    tails.onAgentEvent({ type: "progress", sessionId: ID, progress: { type: "item_finished", item: appended } });
    await waitFlush();
    assert.equal(pushes.length, 1);

    const nextUser = user("u2", "下一句");
    await appendFile(log, `${JSON.stringify(nextUser)}\n`);
    tails.onAgentEvent({ type: "progress", sessionId: ID, progress: { type: "item_started", item: nextUser } });
    await waitFlush();
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1], (await store.tailStat(ID))?.size);
    unwatch();
  });
});
