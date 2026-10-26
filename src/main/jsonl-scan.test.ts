import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEAD_BYTES, headStringField, scanJsonlLines } from "./jsonl-scan.ts";
import { SessionStore } from "./session/store.ts";
import { readPiThinkingTimeline } from "./usage/task-ledger.ts";
import { piThinkingTimeline } from "./usage/task-cost.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-jsonl-scan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function scan(text: string, keep: (head: string) => boolean): Promise<string[]> {
  const file = join(dir, "x.jsonl");
  await writeFile(file, text, "utf8");
  const out: string[] = [];
  await scanJsonlLines(file, keep, (line) => out.push(line));
  return out;
}

describe("scanJsonlLines", () => {
  test("全留时与 split('\\n') 去空行逐行一致：跨块的长行、无尾换行、多字节字符", async () => {
    // 600KB 的行跨过 256KB 的读块边界；中文让多字节字符落在块边界上的概率不为零
    const long = JSON.stringify({ id: "1", role: "tool", text: "工具输出".repeat(150_000) });
    const lines = [long, '{"id":"2","role":"assistant"}', "", "半截{", long, '{"id":"3","role":"user"}'];
    const text = lines.join("\n"); // 最后一行没有换行
    const expected = text.split("\n").filter((l) => l !== "");
    assert.deepEqual(await scan(text, () => true), expected);
  });

  test("按行首丢掉的大行不交出，紧随其后的小行照常交出", async () => {
    const big = JSON.stringify({ id: "t", role: "tool", text: "x".repeat(700_000) });
    const small = '{"id":"a","role":"assistant","n":1}';
    const out = await scan(`${big}\n${small}\n${big}\n${small}\n`, (head) => headStringField(head, "role") !== "tool");
    assert.deepEqual(out, [small, small]);
  });

  test("行首窗口：判定只看前 HEAD_BYTES 字节", async () => {
    const heads: string[] = [];
    await scan(`${"a".repeat(HEAD_BYTES * 3)}\nshort\n`, (head) => {
      heads.push(head);
      return false;
    });
    assert.deepEqual(heads.map((h) => h.length), [HEAD_BYTES, 5]);
  });

  test("文件不存在照抛，由调用方兜底", async () => {
    await assert.rejects(scanJsonlLines(join(dir, "nope.jsonl"), () => true, () => undefined));
  });
});

describe("headStringField", () => {
  test("取行首第一个键值；看不到或被窗口截断返回 undefined", () => {
    assert.equal(headStringField('{"id":"x","role":"assistant","content":[]}', "role"), "assistant");
    assert.equal(headStringField('{"id":"x","content":[]}', "role"), undefined);
    assert.equal(headStringField('{"id":"x","role":"assis', "role"), undefined);
  });
});

describe("回填的两个流式读者与整份读结果一致", () => {
  const ID = "00000000-0000-4000-8000-000000000001";

  test("SessionStore.readUsageLog = readRawLog 只留 assistant / intent-recall（含行首看不到 role 的行）", async () => {
    const sessions = join(dir, "sessions");
    const store = new SessionStore(sessions, join(dir, "wb"));
    const rows = [
      { id: "u1", role: "user", content: [{ type: "text", text: "嗨" }], timestamp: 1 },
      { id: "a1", role: "assistant", content: [], timestamp: 2 },
      { id: "t1", role: "tool", toolCallId: "c", content: [{ type: "text", text: "y".repeat(400_000) }], timestamp: 3 },
      { id: "i1", role: "intent-recall", timestamp: 4 },
      // 键序异常：role 不在行首窗口里 → 保守整行解析，照样收下
      { pad: "z".repeat(HEAD_BYTES * 2), id: "a2", role: "assistant", content: [], timestamp: 5 },
      { role: "file-turn", id: "f1" },
    ];
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${ID}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n{"id":"半截`, "utf8");
    const raw = await store.readRawLog(ID);
    const expected = raw.filter((r) => r.role === "assistant" || r.role === "intent-recall");
    assert.deepEqual(await store.readUsageLog(ID), expected);
    assert.deepEqual((await store.readUsageLog(ID)).map((r) => r.id), ["a1", "i1", "a2"]);
  });

  test("readUsageLog：会话文件不存在返回空", async () => {
    const store = new SessionStore(join(dir, "none"), join(dir, "wb"));
    assert.deepEqual(await store.readUsageLog(ID), []);
  });

  test("readPiThinkingTimeline = piThinkingTimeline(全文)；读不了返回空", async () => {
    const change = (at: number, level: string) =>
      JSON.stringify({ type: "thinking_level_change", id: "x", parentId: null, timestamp: new Date(at).toISOString(), thinkingLevel: level });
    const text = [
      JSON.stringify({ type: "session", id: "s" }),
      change(1000, "low"),
      JSON.stringify({ type: "message", message: { content: "提到 thinking_level_change 的正文".repeat(10_000) } }),
      change(2000, "high"),
      "坏行 thinking_level_change",
    ].join("\n");
    const file = join(dir, "pi.jsonl");
    await writeFile(file, text, "utf8");
    assert.deepEqual(await readPiThinkingTimeline(file), piThinkingTimeline(text));
    assert.equal((await readPiThinkingTimeline(file)).length, 2);
    assert.deepEqual(await readPiThinkingTimeline(join(dir, "nope.jsonl")), []);
  });
});
