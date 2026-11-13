/**
 * pi-book.ts 的测试：自有只读解析器对 testdata 的三份本机 Proma 真本子逐条对账，加上翻译规则的边界。
 *
 * 对账的另一侧原是 pi-coding-agent 自己的解析（parseSessionEntries → SessionManager.inMemory →
 * getBranch）与此前只读路径的投影（SessionManager.inMemory + appendMessage）。导入器退场后主进程
 * 不再依赖 coding-agent，对照改成快照：testdata/pi-book-snapshot.json 是 2026-11-14 用 pi 1.5.2
 * 的实现跑出来的（entry 数、当前分支的 id 序列、记录的角色序列与整份记录的 sha256）。
 * 本子格式 v3 已冻结，快照不该再变；变了先查是不是解析器改坏了。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionRecord } from "../../shared/session.ts";
import { branchEntries, entriesToRecords, messagesToRecords, parsePiBook, type PiBookEntry } from "./pi-book.ts";

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), "testdata");

interface BookSnapshot {
  entries: number;
  branchIds: string[];
  roles: string[];
  recordsSha256: string;
  projectedRoles: string[];
  projectedSha256: string;
}

async function testdataBooks(): Promise<{ name: string; raw: string }[]> {
  const names = (await readdir(TESTDATA)).filter((name) => name.endsWith(".jsonl")).sort();
  return Promise.all(names.map(async (name) => ({ name, raw: await readFile(join(TESTDATA, name), "utf8") })));
}

async function snapshot(): Promise<Record<string, BookSnapshot>> {
  return JSON.parse(await readFile(join(TESTDATA, "pi-book-snapshot.json"), "utf8")) as Record<string, BookSnapshot>;
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 两份记录比内容：id 是各自铸的，换成序号再比。 */
function withoutIds(records: readonly SessionRecord[]): SessionRecord[] {
  return records.map((record, index) => ({ ...record, id: index }) as unknown as SessionRecord);
}

describe("与 pi 的实现逐条对账（testdata 的三份真实本子，pi 1.5.2 跑出的快照）", () => {
  test("解析与当前分支：entry 数、分支 id 序列与 pi 一致", async () => {
    const books = await testdataBooks();
    const expected = await snapshot();
    assert.equal(books.length, 3);
    for (const { name, raw } of books) {
      const book = parsePiBook(raw);
      assert.equal(book.header.version, 3, name);
      assert.equal(book.entries.length, expected[name]?.entries, name);
      assert.deepEqual(
        branchEntries(book.entries).map((entry) => entry.id),
        expected[name]?.branchIds,
        name,
      );
    }
  });

  test("投影：记录与 pi 当前分支投出的逐条相等（角色序列 + 整份 sha256）", async () => {
    const expected = await snapshot();
    for (const { name, raw } of await testdataBooks()) {
      const ours = entriesToRecords(branchEntries(parsePiBook(raw).entries));
      assert.ok(ours.length > 20, name);
      assert.deepEqual(
        ours.map((record) => record.role),
        expected[name]?.roles,
        name,
      );
      assert.equal(sha256(ours), expected[name]?.recordsSha256, name);
    }
  });

  test("Message[] 投影：messagesToRecords 与此前的 SessionManager.inMemory 投影逐条相等（id 除外）", async () => {
    const expected = await snapshot();
    for (const { name, raw } of await testdataBooks()) {
      const branch = branchEntries(parsePiBook(raw).entries);
      const messages = branch.flatMap((entry) => (entry.type === "message" ? [entry.message as Message] : []));
      // 用户原文：第一条藏起来（注入），其余给一句原文——两条路径的隐藏与替换都要对上
      const users = messages.filter((message) => message.role === "user").length;
      const displays = Array.from({ length: users }, (_, index) => (index === 0 ? null : `原文 ${index}`));
      const ours = messagesToRecords(messages, displays);
      assert.deepEqual(
        ours.map((record) => record.role),
        expected[name]?.projectedRoles,
        name,
      );
      assert.equal(sha256(withoutIds(ours)), expected[name]?.projectedSha256, name);
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
    // pi 迁移后的 v1 本子同样是一条直链（id 是它随机铸的）：投出一问一答
    assert.deepEqual(
      entriesToRecords(branchEntries(book.entries)).map((record) => record.role),
      ["user", "assistant"],
    );

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

  test("messagesToRecords：别家工具里出错收尾的回答留下来并写明出错（空回答也不丢）", () => {
    const messages = [
      { role: "user", content: "问", timestamp: 1 },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "AiSdkModelAdapterError", timestamp: 2 },
      { role: "user", content: "再问", timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "说了一半" }], stopReason: "error", timestamp: 4 },
    ] as unknown as Message[];
    const records = messagesToRecords(messages, ["问", "再问"]);
    const answers = records.flatMap((record) =>
      record.role === "assistant" ? [record.content.map((block) => (block.type === "text" ? block.text : "")).join("|")] : [],
    );
    assert.deepEqual(answers, ["[This answer ended in an error: AiSdkModelAdapterError]", "说了一半|[This answer ended in an error]"]);
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

