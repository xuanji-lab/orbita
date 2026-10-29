/**
 * 记忆条目存储（entries.ts）——层文件、行解析、追加去重与出处盖章。
 * 纯模块直测（node --test）：临时目录当 userData。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEntryStore, parseMemoryEntry } from "./entries.ts";
import type { MemoryEpisode } from "../shared/memory.ts";

function entry(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "mem_1",
    type: "fact",
    text: "用户的项目用 bun 管依赖",
    keywords: ["bun"],
    layer: "workspace",
    scopeId: "ws-1",
    sessionId: "s1",
    turns: [2],
    at: 1000,
    episodeId: "ep_1",
    source: "chat",
    ...overrides,
  };
}

function episode(): MemoryEpisode {
  return {
    episodeId: "ep_1",
    sessionId: "s1",
    scopeId: "ws-1",
    fromTurn: 1,
    toTurn: 3,
    openedAt: 900,
    lastAt: 3000,
    turns: [
      { turn: 1, at: 1000, userText: "u1", assistantText: "a1" },
      { turn: 2, at: 2000, userText: "u2", assistantText: "a2" },
      { turn: 3, at: 3000, userText: "u3", assistantText: "a3" },
    ],
  };
}

test("parseMemoryEntry：合法行全收，可选字段缺席按默认", () => {
  const parsed = parseMemoryEntry(entry());
  assert.notEqual(parsed, null);
  assert.equal(parsed?.status, undefined);
  assert.equal(parsed?.reason, undefined);
});

test("parseMemoryEntry：必填字段不齐（#228 旧格式缺 type/layer）返回 null", () => {
  assert.equal(parseMemoryEntry({ id: "mem_1", text: "旧格式的行", keywords: [], sessionId: "s1", timestamp: 1 }), null);
  assert.equal(parseMemoryEntry(entry({ layer: "workspace", scopeId: undefined })), null); // workspace 层缺 scopeId
  assert.equal(parseMemoryEntry(entry({ turns: [] })), null); // 出处轮号是承诺
  assert.equal(parseMemoryEntry(entry({ type: "mood" })), null);
  assert.equal(parseMemoryEntry("不是对象"), null);
});

test("parseMemoryEntry：轮号去重排序、可选枚举不认识的当缺席", () => {
  const parsed = parseMemoryEntry(entry({ turns: [3, 1, 3], status: "archived" }));
  assert.deepEqual(parsed?.turns, [1, 3]);
  assert.equal(parsed?.status, undefined);
});

test("appendScope：盖章 id/出处/episodeId，轮号夹回段内，时间位置取最新支撑轮", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const written = await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "事实一", keywords: ["k"], turns: [2, 99] },
    { type: "preference", text: "偏好一", reason: "因为", keywords: [], turns: [1, 3], pendingPromote: true },
  ]);
  assert.equal(written.length, 2);
  assert.equal(written[0]?.turns.length, 1); // 99 是段外轮号，夹掉了
  assert.equal(written[0]?.at, 2000);
  assert.equal(written[1]?.at, 3000);
  assert.equal(written[1]?.pendingPromote, true);
  // 再读回来：行完整、按层落对文件（sha1(ws-1).jsonl）
  const listed = await store.listScope("ws-1");
  assert.equal(listed.length, 2);
  const names = await readdir(dir);
  assert.equal(names.length, 1);
  assert.notEqual(names[0], "user.jsonl");
});

test("appendScope：归一化文本去重（同作用域与 user 层都查）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "用户 用 bun", keywords: [], turns: [1] },
  ]);
  // 空白差异算逐字重复
  const again = await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "用户  用\n bun ", keywords: [], turns: [1] },
  ]);
  assert.equal(again.length, 0);
  // user 层已有的也不重复落进工作区层
  await writeFile(
    join(dir, "user.jsonl"),
    `${JSON.stringify(entry({ id: "mem_u", text: "用户用 bun", layer: "user", scopeId: undefined }))}\n`,
    "utf8",
  );
  const third = await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "用户用 bun", keywords: [], turns: [1] },
  ]);
  assert.equal(third.length, 0);
});

test("appendScope：偏好 / 经验没有 reason 的 draft 不落（契约承诺），事实允许", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const written = await store.appendScope("ws-1", episode(), [
    { type: "preference", text: "没理由的偏好", keywords: [], turns: [1] },
    { type: "insight", text: "没依据的经验", keywords: [], turns: [1] },
  ]);
  assert.equal(written.length, 0);
});

test("listUser / listScope：文件不存在 = 空，坏行跳过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  assert.deepEqual(await store.listUser(), []);
  assert.deepEqual(await store.listScope("ws-x"), []);
  const token = store.tokenOf("ws-1");
  await writeFile(join(dir, `${token}.jsonl`), "半截行\n" + `${JSON.stringify(entry())}\n` + "{又一行坏的\n", "utf8");
  const listed = await store.listScope("ws-1");
  assert.equal(listed.length, 1);
});

test("recordInjection：每轮一行（含零命中），只追加", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  await store.recordInjection({ sessionId: "s1", turn: 1, at: 1, hits: [] });
  await store.recordInjection({
    sessionId: "s1",
    turn: 2,
    at: 2,
    hits: [{ id: "mem_1", score: 0.5, pinned: true }],
  });
  const raw = await readFile(join(dir, "injections.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!).hits, []);
});
