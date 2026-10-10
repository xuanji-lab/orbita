/**
 * MemoryStore 的回归网：补 id / sessionId、读回、坏行跳过、作用域隔离。
 * 真文件系统用临时目录（carryover-store.test.ts 同款），不 mock fs。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryDraft } from "../../shared/memory.ts";
import { MemoryStore, memoryScopeOf, parseMemoryEntry } from "./store.ts";

let dir = "";
let store: MemoryStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  store = new MemoryStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = (text: string, keywords: string[], timestamp = 1_700_000_000_000): MemoryDraft => ({
  text,
  keywords,
  timestamp,
});

describe("MemoryStore", () => {
  test("文件还不存在时 list 是空的，不抛", async () => {
    assert.deepEqual(await store.list("ws-a"), []);
  });

  test("append 补 id 与 sessionId，读回逐字段一致", async () => {
    const created = await store.append("ws-a", "session-1", [
      draft("用户偏好用 bun 作为包管理器，禁用 npm", ["bun", "包管理器"]),
      draft("终端面板的默认字号是 13px", ["字号", "终端"]),
    ]);
    assert.equal(created.length, 2);
    assert.match(created[0]?.id ?? "", /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(created[0]?.id, created[1]?.id);
    assert.equal(created[0]?.sessionId, "session-1");
    assert.equal(created[0]?.text, "用户偏好用 bun 作为包管理器，禁用 npm");
    assert.deepEqual(created[0]?.keywords, ["bun", "包管理器"]);
    assert.equal(created[0]?.timestamp, 1_700_000_000_000);

    // 落盘后再读：返回的就是盘上的真相（含主进程补的那两个字段）
    assert.deepEqual(await store.list("ws-a"), created);
  });

  test("append 是追加而不是覆盖：两次写入按顺序都在", async () => {
    await store.append("ws-a", "session-1", [draft("第一条", ["一"])]);
    await store.append("ws-a", "session-2", [draft("第二条", ["二"])]);
    const all = await store.list("ws-a");
    assert.deepEqual(
      all.map((entry) => entry.text),
      ["第一条", "第二条"],
    );
    assert.deepEqual(
      all.map((entry) => entry.sessionId),
      ["session-1", "session-2"],
    );
  });

  test("空批不碰盘：一条 draft 都没有时连文件都不建", async () => {
    assert.deepEqual(await store.append("ws-a", "session-1", []), []);
    await assert.rejects(stat(store.filePath("ws-a")));
    assert.deepEqual(await store.list("ws-a"), []);
  });

  test("边界清洗：空文本整条丢，关键词去空白、丢非字符串、截到 8 个", async () => {
    const created = await store.append("ws-a", "session-1", [
      draft("   ", ["空文本"], 1),
      // 3 as unknown as string：跨进程进来的 keywords 不保证真是字符串数组，清洗在边界上做
      draft("正文", ["", "  ", 3 as unknown as string, ...Array.from({ length: 10 }, (_, index) => `k${index}`)], 2),
    ]);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.text, "正文");
    assert.deepEqual(created[0]?.keywords, ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
  });

  test("坏行跳过不炸：半截 JSON 与字段残缺的行各跳一条，好行照常", async () => {
    const [good] = await store.append("ws-a", "session-1", [draft("好行", ["好"])]);
    assert.ok(good !== undefined);
    await writeFile(
      store.filePath("ws-a"),
      [
        "this line is not json at all", // 半截行 → 跳
        '{"id":"mem_x","text":"缺关键词","sessionId":"s","timestamp":1}', // 字段不齐 → 跳
        '{"id":"","text":"空 id","keywords":[],"sessionId":"s","timestamp":1}', // 空 id → 跳
        '{"id":"mem_y","text":"坏时间戳","keywords":[],"sessionId":"s","timestamp":"昨天"}', // timestamp 非数字 → 跳
        '{"id":"mem_z","text":"关键词里有非字符串","keywords":["ok",3],"sessionId":"s","timestamp":1}', // → 跳
        JSON.stringify(good), // 好行保留
        "", // 末尾空行（写文件常带的尾换行）
      ].join("\n") + "\n",
      "utf8",
    );
    const all = await store.list("ws-a");
    assert.deepEqual(
      all.map((entry) => entry.id),
      [good.id],
    );
  });

  test("作用域隔离：两个作用域各写各的，互不看见，文件名也不同", async () => {
    await store.append("ws-a", "session-1", [draft("A 的记忆", ["a"])]);
    await store.append("C:/work/project", "session-2", [draft("B 的记忆", ["b"])]);
    assert.deepEqual(
      (await store.list("ws-a")).map((entry) => entry.text),
      ["A 的记忆"],
    );
    assert.deepEqual(
      (await store.list("C:/work/project")).map((entry) => entry.text),
      ["B 的记忆"],
    );
    assert.notEqual(store.filePath("ws-a"), store.filePath("C:/work/project"));
    // 文件名是定长哈希：任意作用域（含 Windows 路径）都不会拼出非法文件名
    assert.match(store.filePath("C:/work/project"), /[0-9a-f]{40}\.jsonl$/);
  });

  test("读不了 ≠ 没有：文件读失败照抛，不装作空库", async () => {
    // 作用域那个路径上是个目录：readFile 撞 EISDIR——那说明盘上的东西不是我们以为的样子，
    // 该让调用方看见，不能装作「这个作用域没有记忆」
    await mkdir(store.filePath("ws-a"), { recursive: true });
    await assert.rejects(store.list("ws-a"), (cause: unknown) => (cause as { code?: string }).code === "EISDIR");
  });
});

describe("memoryScopeOf", () => {
  test("有工作区按工作区，没有才退回 cwd", () => {
    assert.equal(memoryScopeOf({ workspaceId: "ws-a", cwd: "C:/work" }), "ws-a");
    assert.equal(memoryScopeOf({ workspaceId: null, cwd: "C:/work" }), "C:/work");
  });
});

describe("parseMemoryEntry", () => {
  test("字段齐的收下，缺字段 / 类型不对的返回 null", () => {
    const entry = { id: "mem_1", text: "t", keywords: ["k"], sessionId: "s", timestamp: 1 };
    assert.deepEqual(parseMemoryEntry(entry), entry);
    assert.equal(parseMemoryEntry(null), null);
    assert.equal(parseMemoryEntry("nope"), null);
    assert.equal(parseMemoryEntry({ id: "mem_1", text: "t", keywords: "k", sessionId: "s", timestamp: 1 }), null);
    assert.equal(parseMemoryEntry({ id: "mem_1", text: "t", keywords: ["k"], sessionId: "s" }), null);
  });
});
