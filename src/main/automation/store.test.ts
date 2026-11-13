import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAutomation } from "./fixtures.ts";
import { AUTOMATION_ARCHIVE_KEEP, type Automation } from "../../shared/automation.ts";
import { AutomationStore, reconcileSnapshot } from "./store.ts";

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

const LIVE = "automations.json";
const ARCHIVE = "automations-archive.json";

async function idsOnDisk(name: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as { automations: { id: string }[] };
    return parsed.automations.map((automation) => automation.id);
  } catch {
    return [];
  }
}

function ended(id: string, updatedAt = 10, patch: Partial<Automation> = {}): Automation {
  return makeAutomation({ id, status: "completed", endReason: "finished", nextRunAt: null, updatedAt, ...patch });
}

describe("AutomationStore 归档", () => {
  test("变成 completed 的记录移进归档文件：list 不再有它，listAll / get 仍查得到，换实例也在", async () => {
    const store = new AutomationStore(dir);
    await store.insert(makeAutomation({ id: "a" }));
    await store.insert(makeAutomation({ id: "b" }));
    const saved = await store.update("a", (current) => ({ ...current, status: "completed", endReason: "cancelled", nextRunAt: null, updatedAt: 50 }));
    assert.equal(saved?.status, "completed");
    assert.deepEqual((await store.list()).map((automation) => automation.id), ["b"]);
    assert.deepEqual((await store.listAll()).map((automation) => automation.id), ["b", "a"]);
    assert.equal((await store.get("a"))?.endReason, "cancelled");
    assert.deepEqual(await idsOnDisk(LIVE), ["b"]);
    assert.deepEqual(await idsOnDisk(ARCHIVE), ["a"]);
    assert.deepEqual((await readdir(dir)).sort(), [ARCHIVE, LIVE]);
    const reopened = new AutomationStore(dir);
    assert.deepEqual((await reopened.list()).map((automation) => automation.id), ["b"]);
    assert.equal((await reopened.get("a"))?.endReason, "cancelled");
  });

  test("归档的记录完整保留（标题、指令、计划、次数、最后结果、结束原因与时间、创建者）", async () => {
    const store = new AutomationStore(dir);
    const full = makeAutomation({
      id: "full",
      title: "盯构建",
      prompt: "看一下 CI",
      runCount: 7,
      lastResult: "上次：全绿",
      createdBy: { kind: "agent", sessionId: "s1" },
      schedule: { kind: "daily", time: "09:00" },
    });
    await store.insert(full);
    await store.update("full", (current) => ({ ...current, status: "completed", endReason: "expired", nextRunAt: null, updatedAt: 99 }));
    const back = await new AutomationStore(dir).get("full");
    assert.equal(back?.title, "盯构建");
    assert.equal(back?.prompt, "看一下 CI");
    assert.equal(back?.runCount, 7);
    assert.equal(back?.lastResult, "上次：全绿");
    assert.deepEqual(back?.createdBy, { kind: "agent", sessionId: "s1" });
    assert.deepEqual(back?.schedule, { kind: "daily", time: "09:00" });
    assert.equal(back?.endReason, "expired");
    assert.equal(back?.updatedAt, 99);
  });

  test("归档里的记录收到迟到的运行结果：原地更新，不回主文件、不丢", async () => {
    const store = new AutomationStore(dir);
    await store.insert(ended("a"));
    const saved = await store.update("a", (current) => ({ ...current, runCount: 4, updatedAt: 20 }));
    assert.equal(saved?.runCount, 4);
    assert.deepEqual(await idsOnDisk(LIVE), []);
    assert.equal((await new AutomationStore(dir).get("a"))?.runCount, 4);
  });

  test("重新启动：归档里的记录改回非 completed，回到主文件并从归档里拿掉", async () => {
    const store = new AutomationStore(dir);
    await store.insert(ended("a"));
    await store.update("a", (current) => ({ ...current, status: "active", nextRunAt: 5_000, updatedAt: 11 }));
    assert.deepEqual((await store.list()).map((automation) => automation.id), ["a"]);
    assert.deepEqual(await idsOnDisk(LIVE), ["a"]);
    assert.deepEqual(await idsOnDisk(ARCHIVE), []);
  });

  test("remove 归档里的也能删（用户在面板里点删除）；id 在归档里时 insert 撞 id 抛错", async () => {
    const store = new AutomationStore(dir);
    await store.insert(ended("a"));
    await assert.rejects(store.insert(makeAutomation({ id: "a" })), /already exists/);
    assert.equal(await store.remove("a"), true);
    assert.deepEqual(await store.listAll(), []);
    assert.deepEqual(await idsOnDisk(ARCHIVE), []);
  });

  test("归档有上限：只留最近结束的 AUTOMATION_ARCHIVE_KEEP 条，最旧的丢", async () => {
    const store = new AutomationStore(dir);
    const total = AUTOMATION_ARCHIVE_KEEP + 30;
    for (let i = 0; i < total; i += 1) await store.insert(ended(`e${i}`, i + 1));
    const kept = (await store.listAll()).map((automation) => automation.id);
    assert.equal(kept.length, AUTOMATION_ARCHIVE_KEEP);
    assert.equal(kept[0], `e${total - 1}`, "最新结束的在最前");
    assert.equal(kept.includes("e0"), false, "最旧的被丢");
    assert.equal((await idsOnDisk(ARCHIVE)).length, AUTOMATION_ARCHIVE_KEEP);
  });

  test("老数据：升级前主文件里已经是 completed 的，第一次读盘就进归档，不丢不重复；再读一次不变", async () => {
    const legacy = [makeAutomation({ id: "live1" }), ended("old1", 30), ended("old2", 40), makeAutomation({ id: "live2", status: "paused", nextRunAt: null })];
    await writeFile(join(dir, LIVE), JSON.stringify({ version: 1, automations: legacy }), "utf8");
    const store = new AutomationStore(dir);
    assert.deepEqual((await store.list()).map((automation) => automation.id), ["live1", "live2"]);
    assert.deepEqual((await store.listAll()).map((automation) => automation.id), ["live1", "live2", "old2", "old1"]);
    assert.deepEqual(await idsOnDisk(LIVE), ["live1", "live2"]);
    assert.deepEqual(await idsOnDisk(ARCHIVE), ["old2", "old1"]);
    const again = new AutomationStore(dir);
    assert.deepEqual((await again.listAll()).map((automation) => automation.id), ["live1", "live2", "old2", "old1"]);
  });

  test("老数据里 1000 条已结束：归档只留上限那么多，主文件只剩没结束的，读盘是一次性的", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ended(`e${i}`, i + 1));
    await writeFile(join(dir, LIVE), JSON.stringify({ version: 1, automations: [makeAutomation({ id: "keep" }), ...many] }), "utf8");
    const store = new AutomationStore(dir);
    assert.deepEqual((await store.list()).map((automation) => automation.id), ["keep"]);
    assert.equal((await store.listAll()).length, 1 + AUTOMATION_ARCHIVE_KEEP);
    assert.deepEqual(await idsOnDisk(LIVE), ["keep"]);
    assert.equal((await idsOnDisk(ARCHIVE))[0], "e999");
  });

  test("崩溃点 1：归档写完、主文件还没写就崩——两边各有一份，下次读盘按 updatedAt 归到归档，不复活", async () => {
    const store = new AutomationStore(dir);
    await store.insert(makeAutomation({ id: "a", updatedAt: 5 }));
    const liveBefore = await readFile(join(dir, LIVE), "utf8");
    // 主文件换成目录 → 第二步（写主文件）必失败，第一步（写归档）已经成功
    await rm(join(dir, LIVE));
    await mkdir(join(dir, LIVE));
    await assert.rejects(store.update("a", (current) => ({ ...current, status: "completed", endReason: "cancelled", nextRunAt: null, updatedAt: 6 })));
    assert.deepEqual(await idsOnDisk(ARCHIVE), ["a"], "归档先写，已经落盘");
    await rm(join(dir, LIVE), { recursive: true });
    await writeFile(join(dir, LIVE), liveBefore, "utf8");
    assert.deepEqual(await idsOnDisk(LIVE), ["a"], "崩溃现场：两边都有");
    const recovered = new AutomationStore(dir);
    assert.deepEqual((await recovered.list()).map((automation) => automation.id), []);
    assert.equal((await recovered.get("a"))?.status, "completed");
    assert.deepEqual(await idsOnDisk(LIVE), []);
    assert.deepEqual(await idsOnDisk(ARCHIVE), ["a"]);
  });

  test("崩溃点 2：重新启动时主文件写完、归档还没写就崩——两边各有一份，下次读盘活的那份赢", async () => {
    const store = new AutomationStore(dir);
    await store.insert(ended("a", 5));
    const archiveBefore = await readFile(join(dir, ARCHIVE), "utf8");
    await rm(join(dir, ARCHIVE));
    await mkdir(join(dir, ARCHIVE));
    await assert.rejects(store.update("a", (current) => ({ ...current, status: "active", nextRunAt: 9_000, updatedAt: 5 })));
    assert.deepEqual(await idsOnDisk(LIVE), ["a"], "主文件先写，已经落盘");
    await rm(join(dir, ARCHIVE), { recursive: true });
    await writeFile(join(dir, ARCHIVE), archiveBefore, "utf8");
    const recovered = new AutomationStore(dir);
    assert.deepEqual((await recovered.list()).map((automation) => automation.id), ["a"]);
    assert.equal((await recovered.get("a"))?.status, "active");
    assert.deepEqual(await idsOnDisk(ARCHIVE), []);
  });

  test("对账：updatedAt 平手归档赢；活的更新则活的赢；两边都有的 completed 不重复", () => {
    const tie = reconcileSnapshot([makeAutomation({ id: "a", updatedAt: 7 })], [ended("a", 7)]);
    assert.deepEqual(tie.live, []);
    assert.deepEqual(tie.archive.map((automation) => automation.id), ["a"]);
    const liveNewer = reconcileSnapshot([makeAutomation({ id: "a", updatedAt: 8 })], [ended("a", 7)]);
    assert.deepEqual(liveNewer.live.map((automation) => automation.id), ["a"]);
    assert.deepEqual(liveNewer.archive, []);
    const dup = reconcileSnapshot([ended("a", 7)], [ended("a", 7)]);
    assert.deepEqual(dup.live, []);
    assert.equal(dup.archive.length, 1);
  });

  test("归档文件坏了：改名留底、从空开始，主文件的没结束的不受影响", async () => {
    await writeFile(join(dir, LIVE), JSON.stringify({ version: 1, automations: [makeAutomation({ id: "keep" })] }), "utf8");
    await writeFile(join(dir, ARCHIVE), "{坏的", "utf8");
    const store = new AutomationStore(dir, () => 777);
    assert.deepEqual((await store.list()).map((automation) => automation.id), ["keep"]);
    assert.deepEqual(await store.listAll().then((all) => all.length), 1);
    assert.ok((await readdir(dir)).includes(`${ARCHIVE}.bad-777`));
  });

  test("并发 list 与写入：读盘对账只发生一次", async () => {
    await writeFile(join(dir, LIVE), JSON.stringify({ version: 1, automations: [ended("old", 3)] }), "utf8");
    const store = new AutomationStore(dir);
    const results = await Promise.all([store.list(), store.listAll(), store.get("old"), store.list()]);
    assert.equal(results[1].length, 1);
    assert.equal(results[2]?.id, "old");
    assert.deepEqual(await idsOnDisk(ARCHIVE), ["old"]);
  });
});
