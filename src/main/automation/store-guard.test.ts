/**
 * 主进程兜底（2026-11-14 独立验收）：命令串闸门拦不住的写法，不能让记录无声消失。
 * 外部删 / 改文件、改数据目录名、动冷文件，主进程发现后按内存真源写回并留事件。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOMATION_ARCHIVE_KEEP, type Automation } from "../../shared/automation.ts";
import { makeAutomation } from "./fixtures.ts";
import { AUTOMATION_COLD_FILE_NAME, AutomationStore } from "./store.ts";

let root = "";
let dir = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orbita-store-guard-"));
  dir = join(root, "data");
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const LIVE = "automations.json";
const ARCHIVE = "automations-archive.json";
const COLD = AUTOMATION_COLD_FILE_NAME;
const EVENTS = "automations-events.jsonl";

function ended(id: string, updatedAt = 10): Automation {
  return makeAutomation({ id, status: "completed", endReason: "finished", nextRunAt: null, updatedAt });
}

async function events(): Promise<{ kind?: string; file?: string; backup?: string; ack?: boolean }[]> {
  try {
    return (await readFile(join(dir, EVENTS), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind?: string });
  } catch {
    return [];
  }
}

async function ids(name: string): Promise<string[]> {
  try {
    return (JSON.parse(await readFile(join(dir, name), "utf8")) as { automations: { id: string }[] }).automations.map((a) => a.id);
  } catch {
    return [];
  }
}

function fresh(): { store: AutomationStore; notified: () => number } {
  let n = 0;
  const store = new AutomationStore(dir, Date.now, { onGuardEvent: () => (n += 1) });
  return { store, notified: () => n };
}

describe("主文件与热归档：被删 / 被改 / 数据目录被换", () => {
  test("主文件被删：下一次读就按内存写回，留一条 missing 事件，通知 renderer，alerts 里看得见", async () => {
    const { store, notified } = fresh();
    await store.insert(makeAutomation({ id: "a" }));
    await store.insert(makeAutomation({ id: "b" }));
    await rm(join(dir, LIVE));
    assert.deepEqual((await store.list()).map((a) => a.id), ["b", "a"], "内存里的真源一条不少");
    assert.deepEqual(await ids(LIVE), ["b", "a"], "盘上写回来了");
    const logged = await events();
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.kind, "missing");
    assert.equal(logged[0]?.file, LIVE);
    assert.equal(notified(), 1);
    const info = await store.archiveInfo();
    assert.equal(info.alertsTotal, 1);
    assert.equal(info.alerts[0]?.kind, "missing");
  });

  test("主文件被改成别的内容：被改的留成 .tampered-<时间戳>，按内存写回，事件 changed 带 backup 名", async () => {
    const { store } = fresh();
    await store.insert(makeAutomation({ id: "a", title: "原来的" }));
    await writeFile(join(dir, LIVE), JSON.stringify({ version: 1, automations: [] }), "utf8");
    assert.equal((await store.list())[0]?.title, "原来的");
    assert.deepEqual(await ids(LIVE), ["a"]);
    const logged = await events();
    assert.equal(logged[0]?.kind, "changed");
    const backup = logged[0]?.backup ?? "";
    assert.match(backup, /^automations\.json\.tampered-\d+$/);
    assert.equal((await readdir(dir)).includes(backup), true);
    assert.equal(JSON.parse(await readFile(join(dir, backup), "utf8")).automations.length, 0, "被改的那份原样留着给人看");
  });

  test("热归档被删 / 被改：同样写回，older 与水位随内存带回", async () => {
    const { store } = fresh();
    for (let i = 0; i < AUTOMATION_ARCHIVE_KEEP + 3; i += 1) await store.insert(ended(`e${i}`, i + 1));
    await rm(join(dir, ARCHIVE));
    assert.equal((await store.listAll()).length, AUTOMATION_ARCHIVE_KEEP);
    assert.equal((await ids(ARCHIVE)).length, AUTOMATION_ARCHIVE_KEEP);
    assert.equal(JSON.parse(await readFile(join(dir, ARCHIVE), "utf8")).older, 3);
    await writeFile(join(dir, ARCHIVE), "{}", "utf8");
    await store.listAll();
    assert.equal((await ids(ARCHIVE)).length, AUTOMATION_ARCHIVE_KEEP);
    assert.deepEqual((await events()).map((e) => e.kind), ["missing", "changed"]);
  });

  test("数据目录被改名后应用在原路径重建了空目录：记录写回新目录，一条 dataDirReplaced 事件（不再分别报文件）", async () => {
    const { store } = fresh();
    await store.insert(makeAutomation({ id: "a" }));
    await store.insert(ended("old"));
    await rename(dir, join(root, "data-renamed"));
    await mkdir(dir, { recursive: true });
    assert.deepEqual((await store.list()).map((a) => a.id), ["a"]);
    assert.deepEqual(await ids(LIVE), ["a"]);
    assert.deepEqual(await ids(ARCHIVE), ["old"]);
    const logged = await events();
    assert.deepEqual(logged.map((e) => e.kind), ["dataDirReplaced"]);
    assert.equal(logged[0]?.file, "(data folder)");
  });

  test("数据目录整个不见（没人重建）：mkdir 再写回，同样一条事件", async () => {
    const { store } = fresh();
    await store.insert(makeAutomation({ id: "a" }));
    await rename(dir, join(root, "gone"));
    assert.deepEqual((await store.listAll()).map((a) => a.id), ["a"]);
    assert.deepEqual(await ids(LIVE), ["a"]);
    assert.deepEqual((await events()).map((e) => e.kind), ["dataDirReplaced"]);
  });

  test("合法写入与无害的 touch 不当成篡改：100 次并发读写 + 改 mtime，0 事件", async () => {
    const { store, notified } = fresh();
    await store.insert(makeAutomation({ id: "a" }));
    await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? store.update("a", (c) => ({ ...c, runCount: c.runCount + 1 })) : store.list())));
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, LIVE), later, later); // 只改时间，内容没变
    await store.list();
    assert.deepEqual(await events(), []);
    assert.equal(notified(), 0);
  });

  test("写失败的半成品不算篡改（新旧两份都认）", async () => {
    const { store } = fresh();
    await store.insert(makeAutomation({ id: "a" }));
    await rm(join(dir, LIVE));
    await mkdir(join(dir, LIVE)); // 目标位置是目录 → 写必败
    await assert.rejects(store.insert(makeAutomation({ id: "b" })));
    await rm(join(dir, LIVE), { recursive: true });
    await store.insert(makeAutomation({ id: "c" }));
    assert.deepEqual((await store.list()).map((a) => a.id), ["c", "a"]);
  });

  test("应用关着时文件被改：下次启动以盘上为准，不当篡改（那时没人在守）", async () => {
    const first = fresh().store;
    await first.insert(makeAutomation({ id: "a" }));
    await writeFile(join(dir, LIVE), JSON.stringify({ version: 1, automations: [] }), "utf8");
    const second = fresh().store;
    assert.deepEqual(await second.list(), []);
    assert.deepEqual(await events(), []);
  });

  test("被改的留底只留最新 5 份", async () => {
    let clock = 1000;
    const store = new AutomationStore(dir, () => (clock += 1));
    await store.insert(makeAutomation({ id: "a" }));
    for (let i = 0; i < 8; i += 1) {
      await writeFile(join(dir, LIVE), `{"version":1,"automations":[],"x":${i}}`, "utf8");
      await store.list();
    }
    assert.equal((await readdir(dir)).filter((n) => n.startsWith("automations.json.tampered-")).length, 5);
  });
});

describe("冷文件：有改动看得出来，不悄悄重建", () => {
  async function filled(): Promise<AutomationStore> {
    const { store } = fresh();
    for (let i = 0; i < AUTOMATION_ARCHIVE_KEEP + 5; i += 1) await store.insert(ended(`e${i}`, i + 1));
    return store;
  }

  test("追加后水位随热归档落盘；正常追加（文件变大）不报", async () => {
    const store = await filled();
    const mark = JSON.parse(await readFile(join(dir, ARCHIVE), "utf8")).cold as { size: number };
    assert.equal(mark.size, (await stat(join(dir, COLD))).size);
    await store.insert(ended("more", 9_999));
    assert.deepEqual((await store.archiveInfo()).alerts, []);
  });

  test("冷文件被删：留 coldMissing 事件，不重建空文件，older 照旧，之后不重复报", async () => {
    const store = await filled();
    await rm(join(dir, COLD));
    const info = await store.archiveInfo();
    assert.equal(info.older, 5);
    assert.equal(info.alerts[0]?.kind, "coldMissing");
    await assert.rejects(stat(join(dir, COLD)), "不悄悄建一个空的");
    assert.equal((await store.archiveInfo()).alertsTotal, 1);
    assert.deepEqual((await events()).map((e) => e.kind), ["coldMissing"]);
  });

  test("冷文件头被改 / 被截短：coldChanged；冷文件内容原样不动", async () => {
    const store = await filled();
    const original = await readFile(join(dir, COLD));
    await writeFile(join(dir, COLD), Buffer.concat([Buffer.from("XXXX"), original.subarray(4)]));
    assert.equal((await store.archiveInfo()).alerts[0]?.kind, "coldChanged");
    const edited = await readFile(join(dir, COLD));
    assert.equal(edited.subarray(0, 4).toString(), "XXXX", "不去改它");
    await truncate(join(dir, COLD), 100);
    assert.equal((await store.archiveInfo()).alertsTotal, 2);
  });

  test("追加前核对：挤出时发现冷文件被改，先留事件再追加", async () => {
    const store = await filled();
    await rm(join(dir, COLD));
    await store.insert(ended("newest", 99_999)); // 这次挤出一条，追加前核对到冷文件不见了
    assert.equal((await events())[0]?.kind, "coldMissing");
    assert.equal((await ids(ARCHIVE)).length, AUTOMATION_ARCHIVE_KEEP);
  });

  test("启动时核对：应用关着时冷文件被动过，下次启动留事件", async () => {
    await filled();
    await rm(join(dir, COLD));
    const store = fresh().store;
    assert.equal((await store.archiveInfo()).alerts[0]?.kind, "coldMissing");
  });

  test("冷文件末尾被追加了别的东西：水位处的头尾没变，不报（只增不改是合法的形态）", async () => {
    const store = await filled();
    await appendFile(join(dir, COLD), "{}\n");
    assert.deepEqual((await store.archiveInfo()).alerts, []);
  });
});

describe("事件确认与后台对账", () => {
  test("点「知道了」之后告警清空，事件文件追加一行 ack；换实例不再提示；之后新的篡改照样提示", async () => {
    const { store } = fresh();
    await store.insert(makeAutomation({ id: "a" }));
    await rm(join(dir, LIVE));
    await store.list();
    assert.equal((await store.archiveInfo()).alertsTotal, 1);
    await store.ackAlerts();
    assert.equal((await store.archiveInfo()).alertsTotal, 0);
    assert.equal((await events()).at(-1)?.ack, true);
    assert.equal((await fresh().store.archiveInfo()).alertsTotal, 0);
    await rm(join(dir, LIVE));
    await store.list();
    assert.equal((await store.archiveInfo()).alertsTotal, 1);
    assert.equal((await fresh().store.archiveInfo()).alertsTotal, 1, "没确认的换实例还在");
  });

  test("后台对账：older 与冷文件不符（捏造 / 双计）按冷文件改；热归档里已在冷文件里的孤儿副本拿掉", async () => {
    const { store } = fresh();
    for (let i = 0; i < AUTOMATION_ARCHIVE_KEEP + 2; i += 1) await store.insert(ended(`e${i}`, i + 1));
    // 造三种偏差：older 说 99；热归档里多一份冷文件里已有的 e0；
    const hot = JSON.parse(await readFile(join(dir, ARCHIVE), "utf8")) as { automations: Automation[]; older: number; cold: unknown };
    hot.older = 99;
    hot.automations.push(ended("e0", 1));
    await writeFile(join(dir, ARCHIVE), JSON.stringify(hot), "utf8");
    const reopened = fresh().store;
    await reopened.auditInBackground();
    assert.equal((await reopened.archiveInfo()).older, 2);
    assert.equal((await ids(ARCHIVE)).includes("e0"), false);
    assert.equal((await ids(ARCHIVE)).length, AUTOMATION_ARCHIVE_KEEP);
    assert.equal(JSON.parse(await readFile(join(dir, ARCHIVE), "utf8")).older, 2);
    // 没有偏差时什么都不动
    const before = await readFile(join(dir, ARCHIVE), "utf8");
    await reopened.auditInBackground();
    assert.equal(await readFile(join(dir, ARCHIVE), "utf8"), before);
  });

  test("后台对账：热归档文件缺席但冷文件有记录时，older 按冷文件清点", async () => {
    const { store } = fresh();
    for (let i = 0; i < AUTOMATION_ARCHIVE_KEEP + 2; i += 1) await store.insert(ended(`e${i}`, i + 1));
    await rm(join(dir, ARCHIVE));
    const reopened = fresh().store;
    assert.equal((await reopened.archiveInfo()).older, 0);
    await reopened.auditInBackground();
    assert.equal((await reopened.archiveInfo()).older, 2);
  });

  test("乱序迁入时挤进冷文件的是最旧的（按结束时间裁，不按数组位置）", async () => {
    const all = Array.from({ length: AUTOMATION_ARCHIVE_KEEP + 30 }, (_, i) => ended(`e${i}`, i + 1));
    const shuffled = [...all].sort((a, b) => ((a.updatedAt * 7919) % 101) - ((b.updatedAt * 7919) % 101));
    await writeFile(join(dir, ARCHIVE), JSON.stringify({ version: 1, automations: shuffled, older: 0 }), "utf8");
    const store = fresh().store;
    const hot = (await store.listAll()).map((a) => a.id);
    assert.equal(hot.length, AUTOMATION_ARCHIVE_KEEP);
    const cold = (await readFile(join(dir, COLD), "utf8")).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id).sort();
    assert.deepEqual(cold, Array.from({ length: 30 }, (_, i) => `e${i}`).sort(), "冷文件里正好是最旧的 30 条");
    assert.equal(hot.includes("e0"), false);
    assert.equal(hot.includes("e229"), true);
  });

  test("运行中挤出也一样：归档尾部那条收到迟到结果后 updatedAt 变新，被挤出的仍是最旧的（settle 路径）", async () => {
    // 盘上恰好 200 条不超限（启动对账不重排）：eMax + e1..e199 新→旧，数组末尾是 e199（最旧）
    const newest = ended("eMax", 999_999);
    const rest = Array.from({ length: AUTOMATION_ARCHIVE_KEEP - 1 }, (_, i) => ended(`e${i + 1}`, 5000 - i));
    await writeFile(join(dir, ARCHIVE), JSON.stringify({ version: 1, automations: [newest, ...rest], older: 0 }), "utf8");
    const store = fresh().store;
    await store.listAll();
    // 归档尾部的 e199 收到迟到结果：updatedAt 变新（6000，比 e1..e198 都新），但数组位置不动（验收 F3 场景）
    await store.update("e199", (c) => ({ ...c, lastResult: "迟到", updatedAt: 6000 }));
    await store.insert(ended("fresh", 888_888)); // 第 201 条：挤出 1 条，应是最旧的 e198，不是数组末尾的 e199
    const cold = (await readFile(join(dir, COLD), "utf8")).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id);
    assert.deepEqual(cold, ["e198"], "挤进冷文件的是 updatedAt 最小的那条");
    assert.equal((await store.listAll()).some((a) => a.id === "e199"), true, "迟到变新的 e199 还在热归档里");
  });
});
