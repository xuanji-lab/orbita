/**
 * pi-book.ts 的测试：自有只读解析器与 pi 的实现逐条对账（testdata 的三份本机 Proma 真本子），
 * 加上翻译规则的边界。
 *
 * 对照用 pi-coding-agent 自己的解析（parseSessionEntries → SessionManager.inMemory → getBranch）
 * 与此前只读路径的投影（SessionManager.inMemory + appendMessage）。导入器删除时这一段改成快照对照。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionRecord } from "../../shared/session.ts";
import { branchEntries, entriesToRecords, messagesToRecords, parsePiBook, type PiBookEntry } from "./pi-book.ts";
import { withUserTexts } from "./proma-user-text.ts";

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), "testdata");

async function testdataBooks(): Promise<{ name: string; raw: string }[]> {
  const names = (await readdir(TESTDATA)).filter((name) => name.endsWith(".jsonl")).sort();
  return Promise.all(names.map(async (name) => ({ name, raw: await readFile(join(TESTDATA, name), "utf8") })));
}

/** pi 的当前分支（它自己的 buildSessionPath 走 getBranch）。 */
function piBranch(raw: string): SessionEntry[] {
  const fileEntries = parseSessionEntries(raw);
  return SessionManager.inMemory("/tmp/pi-book-oracle", undefined, fileEntries).getBranch();
}

/** 此前只读路径的投影：SessionManager.inMemory + appendMessage 逐条灌入（external-session 的 recordsOf）。 */
function oldProjection(messages: readonly Message[], userDisplays: readonly (string | null)[]): SessionRecord[] {
  const manager = SessionManager.inMemory("/tmp/pi-book-oracle");
  const hidden = new Set<string>();
  const texts = new Map<string, string>();
  let userIndex = 0;
  for (const message of messages) {
    const id = manager.appendMessage(message);
    if (message.role !== "user") continue;
    const display = userDisplays[userIndex] ?? null;
    userIndex += 1;
    if (display === null) hidden.add(id);
    else texts.set(id, display);
  }
  const records = entriesToRecords(branchEntries(manager.getEntries())).filter(
    (record) => record.role !== "user" || !hidden.has(record.id),
  );
  return withUserTexts(records, texts);
}

/** 两份记录比内容：id 是各自铸的，换成序号再比。 */
function withoutIds(records: readonly SessionRecord[]): unknown[] {
  return records.map((record, index) => ({ ...record, id: index }));
}

describe("与 pi 的实现逐条对账（testdata 的三份真实本子）", () => {
  test("解析：header、entry 列表与当前分支和 pi 一致", async () => {
    const books = await testdataBooks();
    assert.equal(books.length, 3);
    for (const { name, raw } of books) {
      const book = parsePiBook(raw);
      const piEntries = parseSessionEntries(raw).filter((entry) => entry.type !== "session");
      assert.deepEqual(book.entries, piEntries, name);
      assert.equal(book.header.version, 3, name);
      assert.deepEqual(
        branchEntries(book.entries).map((entry) => entry.id),
        piBranch(raw).map((entry) => entry.id),
        name,
      );
    }
  });

  test("投影：记录与 pi 当前分支投出的逐条相等", async () => {
    for (const { name, raw } of await testdataBooks()) {
      const ours = entriesToRecords(branchEntries(parsePiBook(raw).entries));
      const theirs = entriesToRecords(piBranch(raw));
      assert.ok(ours.length > 20, name);
      assert.deepEqual(ours, theirs, name);
    }
  });

  test("Message[] 投影：messagesToRecords 与此前的 SessionManager.inMemory 投影逐条相等（id 除外）", async () => {
    for (const { name, raw } of await testdataBooks()) {
      const messages = piBranch(raw).flatMap((entry) => (entry.type === "message" ? [entry.message as Message] : []));
      // 用户原文：第一条藏起来（注入），其余给一句原文——两条路径的隐藏与替换都要对上
      const users = messages.filter((message) => message.role === "user").length;
      const displays = Array.from({ length: users }, (_, index) => (index === 0 ? null : `原文 ${index}`));
      const ours = messagesToRecords(messages, displays);
      assert.deepEqual(withoutIds(ours), withoutIds(oldProjection(messages, displays)), name);
      // 稳定 id：同一份输入两次读出同样的记录
      assert.deepEqual(messagesToRecords(messages, displays), ours, name);
    }
  });

  test("v1 / v2 本子在内存里迁到 v3：补 id 链、hookMessage 改名 custom，与 pi 迁移后的分支同形", () => {
    const v1 = [
      JSON.stringify({ type: "session", id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "问", timestamp: 1 } }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "答" }], stopReason: "stop", timestamp: 2 } }),
    ].join("\n");
    const book = parsePiBook(v1);
    assert.equal(book.header.version, 1);
    assert.deepEqual(
      book.entries.map((entry) => [entry.id, entry.parentId]),
      [
        ["v1-0", null],
        ["v1-1", "v1-0"],
      ],
    );
    assert.deepEqual(withoutIds(entriesToRecords(branchEntries(book.entries))), withoutIds(entriesToRecords(piBranch(v1))));

    const v2 = [
      JSON.stringify({ type: "session", version: 2, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" }),
      JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "hookMessage", content: "x" } }),
    ].join("\n");
    const migrated = parsePiBook(v2).entries[0]?.message as { role: string };
    assert.equal(migrated.role, "custom");
  });

  test("坏行跳过；没有 header、版本超前如实抛错", () => {
    const raw = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" }),
      "{not json",
      JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: "t", message: { role: "user", content: "问", timestamp: 1 } }),
    ].join("\n");
    assert.deepEqual(parsePiBook(raw).entries.map((entry) => entry.id), ["u"]);
    assert.deepEqual(parsePiBook(raw).header, { version: 3, id: "s", cwd: "/w", timestamp: Date.parse("2026-01-01T00:00:00.000Z") });
    assert.throws(() => parsePiBook(JSON.stringify({ type: "message", id: "u" })), /no session header/);
    assert.throws(() => parsePiBook(JSON.stringify({ type: "session", version: 4 })), /newer than supported/);
  });

  test("messagesToRecords：源里的压缩落在原位成界碑", () => {
    const messages = [
      { role: "user", content: "旧问题", timestamp: 1 },
      { role: "user", content: "新问题", timestamp: 3 },
    ] as Message[];
    const records = messagesToRecords(messages, ["旧问题", "新问题"], [{ at: 1, summary: "摘要", tokensBefore: 9, timestamp: 2 }]);
    assert.deepEqual(
      records.map((record) => record.role),
      ["user", "compacted", "user"],
    );
    const mark = records[1];
    assert.ok(mark?.role === "compacted");
    assert.equal(mark.summary, "摘要");
    assert.equal(mark.timestamp, 2);
  });
});

describe("边界：entries → records 的翻译规则", () => {
  /** 直接对纯函数喂 entry 数组（不经文件）。 */
  const entry = (value: unknown): PiBookEntry => value as PiBookEntry;

  test("空 error 回答不进 transcript（与落盘/分支对账同一谓词）", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "assistant", content: [], stopReason: "error" } }),
    ]);
    assert.equal(records.length, 0);
  });

  test("带内容的 error 回答保留（status=error）", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "挂了" }], stopReason: "error" } }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "assistant");
    if (records[0]?.role === "assistant") assert.equal(records[0].status, "error");
  });

  test("compaction entry → CompactedRecord 界碑", () => {
    const records = entriesToRecords([
      entry({ type: "compaction", id: "c1", parentId: null, timestamp: "2026-09-01T00:00:00.000Z", summary: "此前的一切", firstKeptEntryId: "e1", tokensBefore: 12345 }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "compacted");
    if (records[0]?.role === "compacted") {
      assert.equal(records[0].summary, "此前的一切");
      assert.equal(records[0].tokensBefore, 12345);
    }
  });

  test("孤儿 toolResult（前文没有对应 toolCall）→ input 落 {}", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "t1", parentId: null, timestamp: "t", message: { role: "toolResult", toolCallId: "ghost", toolName: "read", content: [{ type: "text", text: "…" }], isError: false } }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "tool");
    if (records[0]?.role === "tool") assert.deepEqual(records[0].input, {});
  });

  test("未知 role / 未知块 / model_change / thinking_level_change 都不进 transcript", () => {
    const records = entriesToRecords([
      entry({ type: "model_change", id: "mc", parentId: null, timestamp: "t", provider: "x", modelId: "y" }),
      entry({ type: "thinking_level_change", id: "tl", parentId: "mc", timestamp: "t", thinkingLevel: "high" }),
      entry({ type: "custom", id: "cu", parentId: "tl", timestamp: "t", customType: "x" }),
      entry({ type: "message", id: "u1", parentId: "cu", timestamp: "t", message: { role: "user", content: [{ type: "sticker", emoji: "x" }], timestamp: 1 } }),
    ]);
    // user 消息进来但未知块被丢 → 空内容块
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "user");
    if (records[0]?.role === "user") assert.equal(records[0].content.length, 0);
  });

  test("user 的字符串 content 也翻成 text 块；usage 缺席的 assistant 不带 usage 键", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "u", parentId: null, timestamp: "t", message: { role: "user", content: "纯字符串", timestamp: 1 } }),
      entry({ type: "message", id: "a", parentId: "u", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "答" }], stopReason: "stop" } }),
    ]);
    assert.equal(records.length, 2);
    if (records[0]?.role === "user") assert.deepEqual(records[0].content, [{ type: "text", text: "纯字符串" }]);
    if (records[1]?.role === "assistant") assert.equal("usage" in records[1], false);
  });

  test("压缩过的会话：transcript 是全量历史，界碑落在压缩的原位（不是发给模型的压缩上下文）", () => {
    const entries: PiBookEntry[] = [
      entry({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "压缩前的旧问题" }], timestamp: 1 } }),
      entry({ type: "compaction", id: "c", parentId: "m1", timestamp: "2026-09-01T00:00:02.000Z", summary: "折叠摘要", firstKeptEntryId: "m2", tokensBefore: 100 }),
      entry({ type: "message", id: "m2", parentId: "c", timestamp: "2026-09-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "压缩后的新问题" }], timestamp: 3 } }),
    ];
    // pi 发给模型的上下文（buildContextEntries）只有 ["c", "m2"]；transcript 要全量
    const records = entriesToRecords(branchEntries(entries));
    assert.deepEqual(
      records.map((record) => record.role),
      ["user", "compacted", "user"],
    );
    const first = records[0];
    assert.ok(first?.role === "user" && first.content[0]?.type === "text");
    assert.equal(first.content[0].text, "压缩前的旧问题");
  });

  test("回退重答：旧枝不在当前分支上，与 Proma 界面一致；成环不死循环", () => {
    const user = (id: string, parentId: string | null, text: string): PiBookEntry =>
      entry({ type: "message", id, parentId, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
    const rewound = [user("a", null, "一"), user("b", "a", "旧枝"), user("c", "a", "新枝")];
    assert.deepEqual(branchEntries(rewound).map((e) => e.id), ["a", "c"]);
    const looped = [user("x", "y", "x"), user("y", "x", "y")];
    assert.deepEqual(branchEntries(looped).map((e) => e.id), ["x", "y"]);
    assert.deepEqual(branchEntries([]), []);
  });
});

