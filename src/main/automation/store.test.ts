import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAutomation } from "./fixtures.ts";
import { AutomationStore } from "./store.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-automation-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AutomationStore", () => {
  test("文件不存在 = 空列表；insert 后落盘、换一个实例读得回来", async () => {
    const store = new AutomationStore(dir);
    assert.deepEqual(await store.list(), []);
    await store.insert(makeAutomation({ id: "a" }));
    await store.insert(makeAutomation({ id: "b" }));
    const reopened = new AutomationStore(dir);
    assert.deepEqual((await reopened.list()).map((automation) => automation.id), ["b", "a"]);
  });

  test("落盘是原子写：目录里只有 automations.json，没有残留的临时文件", async () => {
    const store = new AutomationStore(dir);
    await store.insert(makeAutomation({ id: "a" }));
    await store.update("a", (current) => ({ ...current, title: "改名" }));
    assert.deepEqual(await readdir(dir), ["automations.json"]);
    const onDisk = JSON.parse(await readFile(join(dir, "automations.json"), "utf8")) as { version: number; automations: { title: string }[] };
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.automations[0]?.title, "改名");
  });

  test("update：fn 返回 null 表示不改；不存在的 id 返回 null；返回写入后的值", async () => {
    const store = new AutomationStore(dir);
    await store.insert(makeAutomation({ id: "a" }));
    assert.equal((await store.update("a", () => null))?.id, "a");
    assert.equal(await store.update("zzz", (current) => current), null);
    const saved = await store.update("a", (current) => ({ ...current, runCount: 3 }));
    assert.equal(saved?.runCount, 3);
    assert.equal((await store.get("a"))?.runCount, 3);
  });

  test("remove：删掉返回 true，没有这条返回 false", async () => {
    const store = new AutomationStore(dir);
    await store.insert(makeAutomation({ id: "a" }));
    assert.equal(await store.remove("a"), true);
    assert.equal(await store.remove("a"), false);
    assert.deepEqual(await store.list(), []);
  });

  test("id 撞了抛错，不覆盖", async () => {
    const store = new AutomationStore(dir);
    await store.insert(makeAutomation({ id: "a", title: "原来的" }));
    await assert.rejects(store.insert(makeAutomation({ id: "a", title: "撞了" })), /already exists/);
    assert.equal((await store.get("a"))?.title, "原来的");
  });

  test("并发的读-改-写串行化：100 次自增不丢更新", async () => {
    const store = new AutomationStore(dir);
    await store.insert(makeAutomation({ id: "a" }));
    await Promise.all(
      Array.from({ length: 100 }, () => store.update("a", (current) => ({ ...current, runCount: current.runCount + 1 }))),
    );
    assert.equal((await store.get("a"))?.runCount, 100);
    assert.equal((await new AutomationStore(dir).get("a"))?.runCount, 100);
  });

  test("坏 JSON：整份改名为 .bad-<时间戳> 留给人看，从空开始，且能继续写", async () => {
    await writeFile(join(dir, "automations.json"), '{"version":1,"automations":[{"id":"a"', "utf8");
    const store = new AutomationStore(dir, () => 4242);
    assert.deepEqual(await store.list(), []);
    const names = await readdir(dir);
    assert.ok(names.includes("automations.json.bad-4242"), names.join(","));
    assert.equal(await readFile(join(dir, "automations.json.bad-4242"), "utf8"), '{"version":1,"automations":[{"id":"a"');
    await store.insert(makeAutomation({ id: "n" }));
    assert.deepEqual((await new AutomationStore(dir).list()).map((automation) => automation.id), ["n"]);
  });

  test("单条残缺只丢那一条，重复 id 只留第一条，其余照读", async () => {
    const good = makeAutomation({ id: "ok" });
    await writeFile(
      join(dir, "automations.json"),
      JSON.stringify({ version: 1, automations: [good, { id: "bad", title: "缺字段" }, "garbage", good] }),
      "utf8",
    );
    const list = await new AutomationStore(dir).list();
    assert.deepEqual(list.map((automation) => automation.id), ["ok"]);
  });

  test("写盘失败：内存不变、调用方拿到抛错，下一次写照常", async () => {
    const store = new AutomationStore(join(dir, "sub"));
    await store.insert(makeAutomation({ id: "a" }));
    // 把目标文件换成一个目录，rename 覆盖目录必失败
    await rm(join(dir, "sub", "automations.json"));
    await mkdir(join(dir, "sub", "automations.json"));
    await assert.rejects(store.insert(makeAutomation({ id: "b" })));
    assert.deepEqual((await store.list()).map((automation) => automation.id), ["a"]);
    await rm(join(dir, "sub", "automations.json"), { recursive: true });
    await store.insert(makeAutomation({ id: "c" }));
    assert.deepEqual((await store.list()).map((automation) => automation.id), ["c", "a"]);
  });
});
