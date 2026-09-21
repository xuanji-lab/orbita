import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CarryoverStore } from "./carryover-store.ts";

let dir = "";
let file = "";
let store: CarryoverStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-carryover-"));
  file = join(dir, "carryovers.jsonl");
  store = new CarryoverStore(file);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("CarryoverStore", () => {
  test("文件还不存在时 list 是空的，不抛", async () => {
    assert.deepEqual(await store.list(), []);
  });

  test("空文件返回 []", async () => {
    await writeFile(file, "", "utf8");
    assert.deepEqual(await store.list(), []);
  });

  test("批量写入 → 读回：字段齐全、status 起步 open、doneAt 为 null", async () => {
    const created = await store.append("session-a", [
      { title: "补上 README 的安装段", detail: "用户第 3 轮要求补安装文档", sourceMessageRange: [4, 6] },
      { title: "跑一遍全量测试", detail: "答应改完跑 bun run test", sourceMessageRange: null },
    ]);
    assert.equal(created.length, 2);
    assert.equal(created[0]?.title, "补上 README 的安装段");
    assert.equal(created[0]?.sourceSessionId, "session-a");
    assert.equal(created[0]?.status, "open");
    assert.equal(created[0]?.doneAt, null);
    assert.deepEqual(created[0]?.sourceMessageRange, [4, 6]);
    assert.ok(created[0]?.id !== "" && created[1]?.id !== "");
    assert.notEqual(created[0]?.id, created[1]?.id);

    const all = await store.list();
    assert.equal(all.length, 2);
    assert.deepEqual(all[0], created[0]);
    assert.deepEqual(all[1], created[1]);
  });

  test("append 是合并而不是覆盖：两次写入互不吞", async () => {
    await store.append("session-a", [{ title: "事项一", detail: "", sourceMessageRange: null }]);
    await store.append("session-b", [{ title: "事项二", detail: "", sourceMessageRange: null }]);
    const all = await store.list();
    assert.deepEqual(
      all.map((item) => item.title),
      ["事项一", "事项二"],
    );
    assert.deepEqual(
      all.map((item) => item.sourceSessionId),
      ["session-a", "session-b"],
    );
  });

  test("按 sourceSessionId 过滤读回（多会话混存）", async () => {
    await store.append("session-a", [
      { title: "A-1", detail: "", sourceMessageRange: null },
      { title: "A-2", detail: "", sourceMessageRange: null },
    ]);
    await store.append("session-b", [{ title: "B-1", detail: "", sourceMessageRange: null }]);
    const ofA = (await store.list()).filter((item) => item.sourceSessionId === "session-a");
    assert.deepEqual(
      ofA.map((item) => item.title),
      ["A-1", "A-2"],
    );
  });

  test("status 翻转：open → done 记 doneAt，回 open 清掉", async () => {
    const [created] = await store.append("session-a", [
      { title: "事项", detail: "", sourceMessageRange: null },
    ]);
    assert.ok(created !== undefined);

    const done = await store.setStatus(created.id, "done");
    assert.equal(done?.status, "done");
    assert.equal(typeof done?.doneAt, "number");

    // 落盘后再读：翻转是持久的
    const afterDone = (await store.list()).find((item) => item.id === created.id);
    assert.equal(afterDone?.status, "done");
    assert.equal(afterDone?.doneAt, done?.doneAt);

    const reopened = await store.setStatus(created.id, "open");
    assert.equal(reopened?.status, "open");
    assert.equal(reopened?.doneAt, null);
  });

  test("setStatus 对不存在的 id 返回 null，不写盘", async () => {
    await store.append("session-a", [{ title: "事项", detail: "", sourceMessageRange: null }]);
    assert.equal(await store.setStatus("no-such-id", "done"), null);
    assert.equal((await store.list()).length, 1);
  });

  test("坏行跳过不炸：半截 JSON 与字段残缺的行各跳一条，好行照常", async () => {
    await store.append("session-a", [{ title: "好行", detail: "", sourceMessageRange: null }]);
    const good = (await store.list())[0];
    assert.ok(good !== undefined);
    await writeFile(
      file,
      [
        '{"id":"broken-no-title","sourceSessionId":"x"}', // 缺 title/detail → 跳
        "this line is not json at all", // 半截行 → 跳
        JSON.stringify(good), // 好行保留
        "", // 末尾空行（写文件常带的尾换行）
      ].join("\n") + "\n",
      "utf8",
    );
    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, good.id);
  });
});
