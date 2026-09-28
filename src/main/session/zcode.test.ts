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
    create table message (id text primary key, session_id text, time_created integer, data text, sequence integer);
    create table part (id text primary key, message_id text, session_id text, time_created integer, data text, sequence integer);
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
  db.prepare("insert into message (id, session_id, time_created, data, sequence) values (?, ?, ?, ?, ?)").run(
    id,
    sessionId,
    seq,
    JSON.stringify(data),
    seq,
  );
  parts.forEach((part, index) => {
    db.prepare("insert into part (id, message_id, session_id, time_created, data, sequence) values (?, ?, ?, ?, ?, ?)").run(
      `p_${seq}_${index}`,
      id,
      sessionId,
      seq,
      JSON.stringify(part),
      seq * 100 + index,
    );
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

  /** 真实 revert 的形状（本机三条都是这样）：conversation_rewind，带 target / kept / cut 游标 */
  const revertOf = (fields: Record<string, unknown>): string =>
    JSON.stringify({ kind: "conversation_rewind", scope: "conversation", ...fields });

  /** 1 问 2 答 3 问 4 答 → 回退到 3（kept = 1、2）→ 回退之后接着聊 5 问 6 答 7 问 8 答 */
  function rewoundSession(db: DatabaseSync, revert: Record<string, unknown>): void {
    writeSession(db, "s1", { revert: revertOf(revert) });
    for (let seq = 1; seq <= 8; seq += 1) {
      writeMessage(db, "s1", seq, { role: seq % 2 === 1 ? "user" : "assistant", time: { created: USER_AT + seq } });
    }
  }
  const ids = (db: DatabaseSync): string[] => readZcodeMessages(db, "s1").map((row) => row.id);

  test("回退之后接着聊的两轮照样导入：保留名单 + cut 游标之后的全部（本机真实形状）", () => {
    const db = makeDb();
    try {
      rewoundSession(db, {
        targetMessageID: "s1_mu_3",
        keptMessageIDs: ["s1_mu_1", "s1_ma_2"],
        branchCutAfterMessageID: "s1_ma_4",
        branchGeneration: 1,
      });
      // 3、4 是回退掉的旧枝；5–8 不在保留名单里，但在 cut 游标之后，是 ZCode 里看得见的新枝
      assert.deepEqual(ids(db), ["s1_mu_1", "s1_ma_2", "s1_mu_5", "s1_ma_6", "s1_mu_7", "s1_ma_8"]);
    } finally {
      db.close();
    }
  });

  test("旧数据没有 cut 游标：保留名单 + createdMessageID 起的全部；连 created 都没有就只有名单", () => {
    const db = makeDb();
    try {
      rewoundSession(db, { targetMessageID: "s1_mu_3", keptMessageIDs: ["s1_mu_1", "s1_ma_2"], createdMessageID: "s1_mu_5" });
      assert.deepEqual(ids(db), ["s1_mu_1", "s1_ma_2", "s1_mu_5", "s1_ma_6", "s1_mu_7", "s1_ma_8"]);
    } finally {
      db.close();
    }
    const bare = makeDb();
    try {
      rewoundSession(bare, { targetMessageID: "s1_mu_3", keptMessageIDs: ["s1_mu_1", "s1_ma_2"] });
      assert.deepEqual(ids(bare), ["s1_mu_1", "s1_ma_2"]);
    } finally {
      bare.close();
    }
  });

  test("最老的数据没有保留名单：targetMessageID 之前的，加 createdMessageID 起的", () => {
    const db = makeDb();
    try {
      rewoundSession(db, { targetMessageID: "s1_mu_3", createdMessageID: "s1_mu_7" });
      assert.deepEqual(ids(db), ["s1_mu_1", "s1_ma_2", "s1_mu_7", "s1_ma_8"]);
    } finally {
      db.close();
    }
  });

  test("没有 targetMessageID = 没有回退，全部可见（名单也不看——与 ZCode 一致）；坏 revert 同样全部可见", () => {
    const db = makeDb();
    try {
      rewoundSession(db, { keptMessageIDs: ["s1_mu_1"] });
      assert.equal(ids(db).length, 8);
    } finally {
      db.close();
    }
    const broken = makeDb();
    try {
      writeSession(broken, "s1", { revert: "{不是json" });
      writeMessage(broken, "s1", 1, { role: "user", time: { created: USER_AT } });
      assert.equal(readZcodeMessages(broken, "s1").length, 1);
    } finally {
      broken.close();
    }
  });

  test("cut 游标或 created 指向库里没有的消息：退回只要名单（ZCode 同一条分支）", () => {
    const db = makeDb();
    try {
      rewoundSession(db, { targetMessageID: "s1_mu_3", keptMessageIDs: ["s1_mu_1", "s1_ma_2"], branchCutAfterMessageID: "gone" });
      assert.deepEqual(ids(db), ["s1_mu_1", "s1_ma_2"]);
    } finally {
      db.close();
    }
  });

  test("顺序照 ZCode 的读法：sequence 为空的排最后，同 sequence 按 time_created", () => {
    const db = makeDb();
    try {
      writeSession(db, "s1");
      const insert = db.prepare("insert into message (id, session_id, time_created, data, sequence) values (?, 's1', ?, '{}', ?)");
      insert.run("m_null", 1, null);
      insert.run("m_late", 9, 5);
      insert.run("m_early", 2, 5);
      insert.run("m_first", 7, 1);
      assert.deepEqual(ids(db), ["m_first", "m_early", "m_late", "m_null"]);
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
