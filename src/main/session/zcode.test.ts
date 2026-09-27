/**
 * zcode.ts 的测试。库按 ZCode 的真实 schema 缩样合成（session / message / part 最小列集，
 * 2026-09-28 对本机库 pragma 抄的），行形状对齐本机抽样：键名小写 providerId/modelId、
 * rewind 白名单、timeline part、sequence 显式排序。内容无关，形状真实。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { opencodeToMessages } from "./opencode.ts";
import { readZcodeMessages, readZcodeSessions, zcodeSessionBytes } from "./zcode.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, revert text, time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, data text, sequence integer);
    create table part (id text primary key, message_id text, session_id text, data text, sequence integer);
  `);
  return db;
}

function writeSession(
  db: DatabaseSync,
  id: string,
  options: { parent?: string; directory?: string; title?: string; revert?: string } = {},
): void {
  db.prepare("insert into session values (?, ?, ?, ?, ?, 1000, 2000)").run(
    id,
    options.parent ?? null,
    options.directory ?? null,
    options.title ?? null,
    options.revert ?? null,
  );
}

/** 一条消息：data 原文 + parts（按给定的 sequence 顺序写入库，读出来必须仍按 sequence 排）。 */
function writeMessage(db: DatabaseSync, sessionId: string, seq: number, data: Record<string, unknown>, parts: Record<string, unknown>[] = []): string {
  const id = `${sessionId}_${data["role"] === "user" ? "mu" : "ma"}_${seq}`;
  db.prepare("insert into message values (?, ?, ?, ?)").run(id, sessionId, JSON.stringify(data), seq);
  parts.forEach((part, index) => {
    db.prepare("insert into part values (?, ?, ?, ?, ?)").run(`p_${seq}_${index}`, id, sessionId, JSON.stringify(part), seq * 100 + index);
  });
  return id;
}

const USER_AT = 1757134310000;

describe("readZcodeSessions", () => {
  test("只列根会话，字段按缺省走", () => {
    const db = makeDb();
    try {
      writeSession(db, "root_a", { directory: "C:\\repo", title: "修测试" });
      writeSession(db, "child", { parent: "root_a", title: "子 agent" });
      writeSession(db, "root_b");
      const rows = readZcodeSessions(db);
      assert.deepEqual(rows.map((row) => row.id), ["root_a", "root_b"]);
      assert.equal(rows[0]?.directory, "C:\\repo");
      assert.equal(rows[0]?.title, "修测试");
      assert.equal(rows[0]?.createdAt, 1000);
      assert.equal(rows[1]?.directory, null);
    } finally {
      db.close();
    }
  });
});

describe("readZcodeMessages", () => {
  test("按 sequence 排序、part 挂回正确的消息", () => {
    const db = makeDb();
    try {
      writeSession(db, "s1");
      // 故意按逆序写入：读出必须仍按 sequence
      writeMessage(db, "s1", 2, { role: "assistant", time: { created: 3000 } }, [
        { type: "text", text: "答" },
      ]);
      const userId = writeMessage(db, "s1", 1, { role: "user", time: { created: USER_AT } }, [
        { type: "text", text: "问" },
      ]);
      const rows = readZcodeMessages(db, "s1");
      assert.deepEqual(rows.map((row) => JSON.parse(row.data).role), ["user", "assistant"]);
      assert.equal(rows[0]!.id, userId);
      assert.deepEqual(rows[0]!.parts.map((part) => JSON.parse(part.data).text), ["问"]);
    } finally {
      db.close();
    }
  });

  test("rewind 白名单：keptMessageIDs 之外的消息不复活", () => {
    const db = makeDb();
    try {
      writeSession(db, "s1", { revert: JSON.stringify({ keptMessageIDs: ["s1_mu_1", "s1_ma_2"], kind: "conversation_rewind" }) });
      writeMessage(db, "s1", 1, { role: "user", time: { created: USER_AT } });
      writeMessage(db, "s1", 2, { role: "assistant", time: { created: 3000 } });
      writeMessage(db, "s1", 3, { role: "user", time: { created: 4000 } }); // 回退掉的
      const rows = readZcodeMessages(db, "s1");
      assert.deepEqual(rows.map((row) => row.id), ["s1_mu_1", "s1_ma_2"]);
    } finally {
      db.close();
    }
  });

  test("坏 revert / 不是数组 → 不动（坏记录不清空历史）", () => {
    const db = makeDb();
    try {
      writeSession(db, "s1", { revert: "{不是json" });
      writeMessage(db, "s1", 1, { role: "user", time: { created: USER_AT } });
      writeSession(db, "s2", { revert: JSON.stringify({ other: true }) });
      writeMessage(db, "s2", 1, { role: "user", time: { created: USER_AT } });
      assert.equal(readZcodeMessages(db, "s1").length, 1);
      assert.equal(readZcodeMessages(db, "s2").length, 1);
    } finally {
      db.close();
    }
  });

  test("zcodeSessionBytes：message + part 的 data 字节和", () => {
    const db = makeDb();
    try {
      writeSession(db, "s1");
      writeMessage(db, "s1", 1, { role: "user", time: { created: USER_AT } }, [{ type: "text", text: "hi" }]);
      const bytes = zcodeSessionBytes(db, "s1");
      assert.equal(bytes > 0, true);
      assert.equal(zcodeSessionBytes(db, "missing"), 0);
    } finally {
      db.close();
    }
  });
});

describe("喂给 opencodeToMessages（端到端）", () => {
  test("小写 providerId/modelId 盖章、tool part 转工具对、timeline 与 compaction 跳过", () => {
    const db = makeDb();
    try {
      writeSession(db, "s1");
      writeMessage(db, "s1", 1, { role: "user", time: { created: USER_AT } }, [{ type: "text", text: "看下目录" }]);
      writeMessage(db, "s1", 2, {
        role: "assistant",
        time: { created: USER_AT + 10 },
        providerId: "account:bigmodel-start-plan",
        modelId: "GLM-5.3-Flash",
      }, [
        { type: "step-start" },
        { type: "timeline", timelineType: "x", display: "宿主时间线" },
        { type: "reasoning", text: "想一想" },
        { type: "tool", callID: "c1", tool: "ls", state: { status: "completed", output: "a.txt" } },
        { type: "step-finish", reason: "tool-calls", tokens: { input: 3, output: 5, cache: { read: 0, write: 0 } } },
      ]);
      const parsed = opencodeToMessages(readZcodeMessages(db, "s1"), "scan", null);
      assert.deepEqual(parsed.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
      const assistant = parsed.messages[1] as AssistantMessage;
      assert.equal(assistant.model, "GLM-5.3-Flash");
      assert.equal(assistant.api, "openai-completions");
      assert.equal(assistant.usage.input, 3);
      assert.equal(parsed.stats.compactionMessages, 0);
      // compaction：换一条带 compaction part 的用户消息，确认跳过
      writeMessage(db, "s1", 3, { role: "user", time: { created: 5000 } }, [{ type: "compaction" }]);
      const withCompaction = opencodeToMessages(readZcodeMessages(db, "s1"), "scan", null);
      assert.equal(withCompaction.stats.compactionMessages, 1);
    } finally {
      db.close();
    }
  });
});
