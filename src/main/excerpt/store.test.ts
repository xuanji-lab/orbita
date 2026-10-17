/**
 * 摘抄存储的测试：追加、幂等、截断、坏行跳过、原子删除、文件不存在、新的在前、
 * 并发写入链、会话标题补全。跑法：`node --test src/main/excerpt/store.test.ts`。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXCERPT_MAX_CHARS } from "../../shared/excerpt.ts";
import { attachSessionTitles, ExcerptStore, normalizeExcerptText, parseExcerptLine } from "./store.ts";

let dir = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-excerpt-"));
  file = join(dir, "excerpts.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("add", () => {
  test("正常路径：补 id / createdAt、trim 首尾、落一行可解析的 JSON", async () => {
    const store = new ExcerptStore(file);
    const { excerpt, duplicate } = await store.add({
      sessionId: "s1",
      turn: 3,
      role: "assistant",
      text: "  一段话  \n",
    });
    assert.equal(duplicate, false);
    assert.ok(excerpt.id.startsWith("exc_"));
    assert.ok(excerpt.id.length > "exc_".length);
    assert.equal(excerpt.text, "一段话");
    assert.equal(excerpt.sessionId, "s1");
    assert.equal(excerpt.turn, 3);
    assert.equal(excerpt.role, "assistant");
    assert.ok(Number.isFinite(excerpt.createdAt));
    const raw = await readFile(file, "utf8");
    assert.deepEqual(raw.split("\n"), [JSON.stringify(excerpt), ""]);
    assert.deepEqual(parseExcerptLine(JSON.parse(raw.slice(0, raw.indexOf("\n")))), excerpt);
  });

  test("turn 缺席：落盘行没有 turn 字段（迁移来的旧消息口径）", async () => {
    const store = new ExcerptStore(file);
    const { excerpt } = await store.add({ sessionId: "s1", role: "user", text: "hi" });
    assert.equal(excerpt.turn, undefined);
    assert.equal("turn" in excerpt, false);
    assert.equal(JSON.stringify(excerpt).includes("turn"), false);
  });

  test("截断：trim 之后再截到 EXCERPT_MAX_CHARS 个字符（按字符数，不劈代理对）", async () => {
    const store = new ExcerptStore(file);
    const long = `${" ".repeat(3)}${"字".repeat(EXCERPT_MAX_CHARS + 10)}\n`;
    const { excerpt } = await store.add({ sessionId: "s1", role: "user", text: long });
    assert.equal(Array.from(excerpt.text).length, EXCERPT_MAX_CHARS);
    // 恰好在上限的不截
    const exact = await store.add({ sessionId: "s1", role: "assistant", text: "词".repeat(EXCERPT_MAX_CHARS) });
    assert.equal(Array.from(exact.excerpt.text).length, EXCERPT_MAX_CHARS);
    // emoji（代理对）不在中间劈开
    const emoji = await store.add({ sessionId: "s1", role: "user", text: "🀄".repeat(EXCERPT_MAX_CHARS + 5) });
    assert.equal(Array.from(emoji.excerpt.text).length, EXCERPT_MAX_CHARS);
    assert.ok(Array.from(emoji.excerpt.text).every((ch) => ch === "🀄"));
  });

  test("幂等：同会话同轮同角色、内部空白不同 → 返回已有那条，文件仍一行", async () => {
    const store = new ExcerptStore(file);
    const first = await store.add({ sessionId: "s1", turn: 2, role: "user", text: "第一 段\n\n话" });
    const again = await store.add({ sessionId: "s1", turn: 2, role: "user", text: "  第一  段 话  " });
    assert.equal(again.duplicate, true);
    assert.equal(again.excerpt.id, first.excerpt.id);
    const raw = await readFile(file, "utf8");
    assert.equal(raw.split("\n").filter((line) => line !== "").length, 1);
  });

  test("幂等只认四元组：换会话 / 换轮 / 换角色都是新摘抄", async () => {
    const store = new ExcerptStore(file);
    await store.add({ sessionId: "s1", turn: 1, role: "user", text: "同一段话" });
    assert.equal((await store.add({ sessionId: "s2", turn: 1, role: "user", text: "同一段话" })).duplicate, false);
    assert.equal((await store.add({ sessionId: "s1", turn: 2, role: "user", text: "同一段话" })).duplicate, false);
    assert.equal((await store.add({ sessionId: "s1", turn: 1, role: "assistant", text: "同一段话" })).duplicate, false);
    assert.equal((await store.add({ sessionId: "s1", role: "user", text: "同一段话" })).duplicate, false);
    // turn 缺席 ≠ turn 1（迁移来的旧消息没有轮号，不该被在轮 1 摘的盖住）
    const raw = await readFile(file, "utf8");
    assert.equal(raw.split("\n").filter((line) => line !== "").length, 5);
  });

  test("trim 后为空：兜底抛错，不落盘", async () => {
    const store = new ExcerptStore(file);
    await assert.throws(() => normalizeExcerptText("  \n\t "));
    await assert.rejects(store.add({ sessionId: "s1", role: "user", text: "　" }));
    await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
  });

  test("并发 add 同一内容：写入链串行化，只落一行，其余 duplicate", async () => {
    const store = new ExcerptStore(file);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.add({ sessionId: "s1", turn: 1, role: "user", text: "抢同一段" })),
    );
    assert.equal(results.filter((r) => r.duplicate).length, 4);
    const ids = new Set(results.map((r) => r.excerpt.id));
    assert.equal(ids.size, 1);
    const raw = await readFile(file, "utf8");
    assert.equal(raw.split("\n").filter((line) => line !== "").length, 1);
  });
});

describe("list", () => {
  test("新的在前（追加序倒排）", async () => {
    const store = new ExcerptStore(file);
    await store.add({ sessionId: "s1", role: "user", text: "第一条" });
    await store.add({ sessionId: "s1", role: "assistant", text: "第二条" });
    await store.add({ sessionId: "s2", role: "user", text: "第三条" });
    assert.deepEqual(
      (await store.list()).map((e) => e.text),
      ["第三条", "第二条", "第一条"],
    );
  });

  test("文件不存在 = 空（ENOENT → []）", async () => {
    const store = new ExcerptStore(file);
    assert.deepEqual(await store.list(), []);
  });

  test("坏行跳过：非 JSON、缺字段、role 非法、无结尾换行的半截行，都只丢自己", async () => {
    const good = { id: "exc_1", text: "好行", sessionId: "s1", turn: 1, role: "user", createdAt: 1 };
    await appendFile(file, "not json at all\n", "utf8");
    await appendFile(file, `${JSON.stringify({ id: "exc_2", text: "缺 sessionId" })}\n`, "utf8");
    await appendFile(file, `${JSON.stringify({ ...good, id: "exc_3", role: "system" })}\n`, "utf8");
    await appendFile(file, JSON.stringify(good).slice(0, 20), "utf8"); // 断电写一半的尾行
    await appendFile(file, `\n${JSON.stringify(good)}\n`, "utf8");
    const list = await new ExcerptStore(file).list();
    assert.deepEqual(list.map((e) => e.id), ["exc_1"]);
  });

  test("读不了 ≠ 没有：目标是目录时照抛", async () => {
    const asDir = join(dir, "occupied");
    await mkdir(asDir);
    // 把目录本身当摘抄文件读：EISDIR 不是 ENOENT，属于「读不出来」，必须照抛
    await assert.rejects(new ExcerptStore(asDir).list());
  });
});

describe("remove", () => {
  test("删中间一条：原子重写，剩下的原序保留；再删同 id 返回 false 且不动文件", async () => {
    const store = new ExcerptStore(file);
    const a = await store.add({ sessionId: "s1", role: "user", text: "甲" });
    await store.add({ sessionId: "s1", role: "user", text: "乙" });
    await store.add({ sessionId: "s1", role: "user", text: "丙" });
    assert.equal(await store.remove(a.excerpt.id), true);
    assert.deepEqual(
      (await store.list()).map((e) => e.text),
      ["丙", "乙"],
    );
    const after = await readFile(file, "utf8");
    assert.equal(await store.remove(a.excerpt.id), false);
    assert.equal(await readFile(file, "utf8"), after);
  });

  test("删到空：落空文件（存在、0 行）；坏行在重写时顺带清掉", async () => {
    const store = new ExcerptStore(file);
    const only = await store.add({ sessionId: "s1", role: "user", text: "唯一" });
    await appendFile(file, "garbage\n", "utf8");
    assert.equal(await store.remove(only.excerpt.id), true);
    assert.equal(await readFile(file, "utf8"), "");
    assert.deepEqual(await store.list(), []);
  });

  test("文件不存在：removed = false，不创建文件", async () => {
    const store = new ExcerptStore(file);
    assert.equal(await store.remove("exc_none"), false);
    await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
  });
});

describe("attachSessionTitles", () => {
  test("同一会话只读一次；会话已删 → sessionTitle = null", async () => {
    const excerpts = [
      { id: "exc_a", text: "一", sessionId: "s1", turn: 1, role: "user" as const, createdAt: 3 },
      { id: "exc_b", text: "二", sessionId: "s1", role: "assistant" as const, createdAt: 2 },
      { id: "exc_c", text: "三", sessionId: "s2", role: "user" as const, createdAt: 1 },
    ];
    const reads: string[] = [];
    const items = await attachSessionTitles(excerpts, {
      readMeta: async (id) => {
        reads.push(id);
        return id === "s1" ? { title: "还在的会话" } : null;
      },
    });
    assert.deepEqual(reads, ["s1", "s2"]);
    assert.deepEqual(
      items.map((item) => [item.excerpt.id, item.sessionTitle]),
      [
        ["exc_a", "还在的会话"],
        ["exc_b", "还在的会话"],
        ["exc_c", null],
      ],
    );
  });
});
