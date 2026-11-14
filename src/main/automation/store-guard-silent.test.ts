/**
 * 兜底的「无声漏过」：独立复验（accept-3）找到的六类情形，每类都要有「被发现 + 留下事件 + 用户看得到」。
 * 同尺寸同 mtime 改内容、chmod 000、事件文件被删 / 被伪造 ack、冷文件中段等长改与外部追加、
 * 数据目录改名后旧事件丢在旧目录、应用关着期间被改。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOMATION_ARCHIVE_KEEP, type Automation, type AutomationGuardEvent } from "../../shared/automation.ts";
import { makeAutomation } from "./fixtures.ts";
import { AUTOMATION_COLD_FILE_NAME, AutomationStore } from "./store.ts";

let root = "";
let dir = "";
let mirror = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orbita-guard-silent-"));
  dir = join(root, "data");
  mirror = join(root, "orbita-guard", "data");
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const LIVE = "automations.json";
const ARCHIVE = "automations-archive.json";
const COLD = AUTOMATION_COLD_FILE_NAME;
const EVENTS = "automations-events.jsonl";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function ended(id: string, updatedAt = 10): Automation {
  return makeAutomation({ id, status: "completed", endReason: "finished", nextRunAt: null, updatedAt });
}

function open(options: { fullHashEveryMs?: number } = {}): AutomationStore {
  return new AutomationStore(dir, Date.now, {}, { mirrorDir: mirror, ...options });
}

async function kinds(path = join(dir, EVENTS)): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { kind: string }).kind);
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

async function filledCold(): Promise<AutomationStore> {
  const store = open();
  for (let i = 0; i < AUTOMATION_ARCHIVE_KEEP + 5; i += 1) await store.insert(ended(`e${i}`, i + 1));
  return store;
}

describe("同尺寸、同 mtime、不同内容", () => {
  for (const name of [LIVE, ARCHIVE]) {
    test(`${name}：改内容再把 mtime 钉回去——ctime 变了，照样被发现、按内存写回、留 .tampered- 副本与事件`, async () => {
      const store = open();
      await store.insert(makeAutomation({ id: "a", title: "原来的" }));
      await store.insert(ended("done"));
      const pinned = new Date(1_700_000_000_000); // 整秒，避免亚毫秒精度还原不回来
      await utimes(join(dir, name), pinned, pinned);
      await store.list(); // 应用看到 mtime 变了，哈希一致，重新记基线
      const before = await readFile(join(dir, name), "utf8");
      const tampered = before.replace("原来的", "改过的").replace("done", "doNe");
      assert.equal(tampered.length, before.length);
      assert.notEqual(tampered, before);
      await writeFile(join(dir, name), tampered, "utf8");
      await utimes(join(dir, name), pinned, pinned);
      assert.equal((await stat(join(dir, name))).mtimeMs, pinned.getTime(), "前置条件：mtime 与尺寸都和改之前一样");
      assert.equal((await stat(join(dir, name))).size, Buffer.byteLength(before));
      await store.list();
      assert.equal(await readFile(join(dir, name), "utf8"), before, "按内存写回");
      assert.deepEqual(await kinds(), ["changed"]);
      assert.equal((await readdir(dir)).filter((n) => n.startsWith(`${name}.tampered-`)).length, 1);
    });
  }

  test("没人动的文件不误报：反复读、只改 mtime（touch）都 0 事件", async () => {
    const store = open();
    await store.insert(makeAutomation({ id: "a" }));
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, LIVE), later, later);
    for (let i = 0; i < 5; i += 1) await store.list();
    assert.deepEqual(await kinds(), []);
  });
});

describe("读不了（chmod 000）也是一种状态：记事件、提示，权限恢复后自愈", { skip: isRoot ? "root 不受 chmod 约束" : false }, () => {
  for (const name of [LIVE, ARCHIVE]) {
    test(`${name}：chmod 000 → 一条 unreadable 事件（同一次不重复），恢复权限后下一次核对自愈，内容没动`, async () => {
      const store = open();
      await store.insert(makeAutomation({ id: "a" }));
      await store.insert(ended("done"));
      const before = await readFile(join(dir, name), "utf8");
      await chmod(join(dir, name), 0o000);
      await store.list();
      await store.list();
      assert.deepEqual(await kinds(), ["unreadable"]);
      const info = await store.archiveInfo();
      assert.equal(info.alertsTotal, 1);
      assert.equal(info.alerts[0]?.kind, "unreadable");
      assert.equal(info.alerts[0]?.file, name);
      await chmod(join(dir, name), 0o644);
      await store.list();
      assert.equal(await readFile(join(dir, name), "utf8"), before);
      assert.deepEqual(await kinds(), ["unreadable"], "恢复后不再多报");
      // 恢复后再读不了又是新的一次
      await chmod(join(dir, name), 0o000);
      await store.list();
      assert.deepEqual(await kinds(), ["unreadable", "unreadable"]);
    });
  }

  test("冷文件 chmod 000：unreadable；恢复后自愈", async () => {
    const store = await filledCold();
    await chmod(join(dir, COLD), 0o000);
    await store.list();
    assert.deepEqual(await kinds(), ["unreadable"]);
    assert.equal((await store.archiveInfo()).alerts[0]?.file, COLD);
    await chmod(join(dir, COLD), 0o644);
    await store.list();
    assert.deepEqual(await kinds(), ["unreadable"]);
  });

  test("启动时记录文件读不了：记一条 unreadable 再抛（不吞成空列表）", async () => {
    const first = open();
    await first.insert(makeAutomation({ id: "a" }));
    await chmod(join(dir, LIVE), 0o000);
    await assert.rejects(open().list());
    assert.deepEqual(await kinds(), ["unreadable"]);
  });
});

describe("事件文件与已读位置：被删、被伪造、被外部追加", () => {
  async function withOneEvent(): Promise<AutomationStore> {
    const store = open();
    await store.insert(makeAutomation({ id: "a" }));
    await rm(join(dir, LIVE));
    await store.list(); // missing 事件 seq=1
    return store;
  }

  test("事件文件被删：下一次核对按内存重建，留一条 eventsChanged；历史事件没丢", async () => {
    const store = await withOneEvent();
    await rm(join(dir, EVENTS));
    await store.list();
    assert.deepEqual(await kinds(), ["missing", "eventsChanged"]);
    const info = await store.archiveInfo();
    assert.equal(info.alertsTotal, 2);
  });

  test("事件文件里伪造一行 ack：不能清空历史——留副本、按内存写回、再记一条 eventsChanged；重开实例告警仍在", async () => {
    const store = await withOneEvent();
    await appendFile(join(dir, EVENTS), `${JSON.stringify({ ack: true, at: Date.now() })}\n`);
    await store.list();
    assert.deepEqual(await kinds(), ["missing", "eventsChanged"]);
    assert.equal((await readdir(dir)).filter((n) => n.startsWith(`${EVENTS}.tampered-`)).length, 1);
    assert.equal((await store.archiveInfo()).alertsTotal, 2);
    assert.equal((await open().archiveInfo()).alertsTotal, 2, "重开后还在");
  });

  test("事件文件被截断 / 改写：同样重建，副本留着", async () => {
    const store = await withOneEvent();
    await writeFile(join(dir, EVENTS), "", "utf8");
    await store.list();
    assert.deepEqual(await kinds(), ["missing", "eventsChanged"]);
    const backup = (await readdir(dir)).find((n) => n.startsWith(`${EVENTS}.tampered-`));
    assert.ok(backup);
  });

  test("已读位置带序号：点「知道了」只确认看到的那条，晚到的事件不被一起吞掉；重开实例不再提示已读的", async () => {
    const store = await withOneEvent();
    const seen = (await store.archiveInfo()).alerts[0]?.seq ?? 0;
    assert.equal(seen, 1);
    await rm(join(dir, LIVE));
    await store.list(); // seq=2（主文件又被删）
    await store.ackAlerts(seen);
    const info = await store.archiveInfo();
    assert.equal(info.alertsTotal, 1, "seq=2 是晚到的，没被确认");
    assert.equal(info.alerts[0]?.seq, 2);
    assert.equal((await open().archiveInfo()).alertsTotal, 1);
    await store.ackAlerts();
    assert.equal((await store.archiveInfo()).alertsTotal, 0);
    assert.equal((await open().archiveInfo()).alertsTotal, 0);
  });

  test("已读位置文件被伪造成一个很大的数：运行中被按内存写回（ackChanged），重启后取数据目录与镜像里更小的那个，事件藏不住", async () => {
    const store = await withOneEvent();
    await writeFile(join(dir, "automations-ack.json"), JSON.stringify({ ackedSeq: 999, at: 1 }), "utf8");
    await store.list();
    assert.ok((await kinds()).includes("ackChanged"));
    assert.equal((await store.archiveInfo()).alertsTotal, 2, "missing + ackChanged 都没确认");
    // 关着时伪造数据目录里的那份：另一份（镜像）还是 0
    await writeFile(join(dir, "automations-ack.json"), JSON.stringify({ ackedSeq: 999, at: 1 }), "utf8");
    assert.ok((await open().archiveInfo()).alertsTotal >= 2);
  });

  test("镜像也被监视：镜像目录被删，运行中重建并留一条（mirror）事件", async () => {
    const store = await withOneEvent();
    await rm(mirror, { recursive: true, force: true });
    await store.list();
    const logged = await kinds();
    assert.equal(logged[0], "missing");
    assert.ok(logged.includes("eventsChanged") && logged.includes("ackChanged"), "镜像里两份文件（事件、已读位置）都被发现缺了");
    assert.ok((await store.archiveInfo()).alerts.some((alert) => alert.file.startsWith("(mirror)")));
    assert.equal(await readFile(join(mirror, EVENTS), "utf8").then((text) => text.length > 0), true, "镜像写回来了");
  });

  test("事件日志不误报：正常的事件与确认反复进行，事件文件始终等于内存里的", async () => {
    const store = open();
    await store.insert(makeAutomation({ id: "a" }));
    for (let i = 0; i < 5; i += 1) {
      await rm(join(dir, LIVE));
      await store.list();
      await store.ackAlerts();
    }
    assert.deepEqual(await kinds(), ["missing", "missing", "missing", "missing", "missing"]);
    assert.deepEqual(await kinds(join(mirror, EVENTS)), ["missing", "missing", "missing", "missing", "missing"]);
  });
});

describe("冷文件：精确大小、中段等长改写、外部追加", () => {
  test("外部追加一行合法记录（大小变了）：coldChanged；文件原样不动；水位以当前文件为准，之后不重复报", async () => {
    const store = await filledCold();
    const before = await readFile(join(dir, COLD), "utf8");
    await appendFile(join(dir, COLD), `${JSON.stringify(ended("forged", 5))}\n`);
    const info = await store.archiveInfo();
    assert.equal(info.alerts[0]?.kind, "coldChanged");
    assert.equal((await readFile(join(dir, COLD), "utf8")).startsWith(before), true);
    assert.equal((await store.archiveInfo()).alertsTotal, 1);
  });

  test("中段等长改一字节（头尾都没动）：stat 变了就整份比块哈希，coldChanged", async () => {
    const store = await filledCold();
    const original = await readFile(join(dir, COLD));
    const edited = Buffer.from(original);
    const middle = Math.floor(edited.length / 2);
    edited[middle] = edited[middle] === 0x41 ? 0x42 : 0x41;
    const pinned = new Date(1_700_000_000_000);
    await writeFile(join(dir, COLD), edited);
    await utimes(join(dir, COLD), pinned, pinned);
    assert.equal((await stat(join(dir, COLD))).size, original.length);
    assert.equal((await store.archiveInfo()).alerts[0]?.kind, "coldChanged");
    assert.equal((await readFile(join(dir, COLD))).equals(edited), true, "不去改它");
  });

  test("应用关着时中段被改：启动后的后台审计整份比块哈希，留 coldChanged", async () => {
    await filledCold();
    const original = await readFile(join(dir, COLD));
    const edited = Buffer.from(original);
    const middle = Math.floor(edited.length / 2);
    edited[middle] = (edited[middle] ?? 0) ^ 0x01;
    await writeFile(join(dir, COLD), edited);
    const reopened = open();
    await reopened.list();
    await reopened.auditInBackground();
    assert.ok((await kinds()).includes("coldChanged"));
  });

  test("应用关着时冷文件被同尺寸改一字节：启动那一刻就发现（不大的文件当场整份比块哈希，不用等后台审计）", async () => {
    await filledCold();
    const edited = Buffer.from(await readFile(join(dir, COLD)));
    edited[0] = (edited[0] ?? 0) ^ 0x01;
    await writeFile(join(dir, COLD), edited);
    const reopened = open();
    assert.equal((await reopened.archiveInfo()).alerts[0]?.kind, "coldChanged");
  });

  test("关着时同时删掉热归档里的水位并改冷文件：数据目录之外的指纹里还有一份水位，照样发现", async () => {
    await filledCold();
    const hot = JSON.parse(await readFile(join(dir, ARCHIVE), "utf8")) as Record<string, unknown>;
    delete hot["cold"];
    await writeFile(join(dir, ARCHIVE), `${JSON.stringify(hot, null, 2)}\n`, "utf8");
    const edited = Buffer.from(await readFile(join(dir, COLD)));
    edited[5] = (edited[5] ?? 0) ^ 0x01;
    await writeFile(join(dir, COLD), edited);
    const reopened = open();
    const info = await reopened.archiveInfo();
    assert.ok(info.alerts.some((alert) => alert.kind === "coldChanged"), "冷文件被改");
    assert.ok(info.alerts.some((alert) => alert.kind === "changedWhileClosed" && alert.file === ARCHIVE), "热归档文件也被改过");
  });

  test("正常追加（挤出一条）后水位只重算最后一块：之后读与核对 0 事件，且重开后仍然对得上", async () => {
    const store = await filledCold();
    for (let i = 0; i < 10; i += 1) await store.insert(ended(`more${i}`, 1000 + i));
    await store.list();
    assert.deepEqual(await kinds(), []);
    const reopened = open();
    await reopened.auditInBackground();
    assert.deepEqual(await kinds(), []);
    const mark = JSON.parse(await readFile(join(dir, ARCHIVE), "utf8")).cold as { size: number; blocks: string[] };
    assert.equal(mark.size, (await stat(join(dir, COLD))).size);
    assert.ok(mark.blocks.length >= 1);
  });
});

describe("数据目录改名：事件从镜像补回，提示里说清旧目录在哪", () => {
  test("运行中改名后原路径重建空目录：新目录的事件文件带着全部历史，dataDirReplaced 带 movedTo 与「进行中 + 已归档」条数", async () => {
    const store = open();
    await store.insert(makeAutomation({ id: "a" }));
    await store.insert(ended("old"));
    await rm(join(dir, LIVE));
    await store.list(); // 先有一条历史事件
    await rename(dir, join(root, "data-moved"));
    await mkdir(dir, { recursive: true });
    await store.list();
    assert.deepEqual(await ids(LIVE), ["a"]);
    assert.deepEqual(await kinds(), ["missing", "dataDirReplaced"], "新目录里有改名前的历史 + 这次的事件");
    const latest = (await store.archiveInfo()).alerts[0] as AutomationGuardEvent;
    assert.equal(latest.kind, "dataDirReplaced");
    assert.equal(latest.records, 1);
    assert.equal(latest.archived, 1);
    assert.equal(latest.movedTo, join(root, "data-moved"));
  });

  test("应用关着时数据目录被改名并重建为空：启动时事件从镜像补回，留 changedWhileClosed（带旧目录）与 eventsChanged", async () => {
    const first = open();
    await first.insert(makeAutomation({ id: "a" }));
    await rm(join(dir, LIVE));
    await first.list(); // 一条历史事件 missing
    await rename(dir, join(root, "data-moved"));
    await mkdir(dir, { recursive: true });
    const second = open();
    await second.list();
    const all = await kinds();
    assert.equal(all[0], "missing", "镜像里的历史补回来了");
    assert.ok(all.includes("changedWhileClosed"));
    const info = await second.archiveInfo();
    const closed = info.alerts.find((alert) => alert.kind === "changedWhileClosed" && alert.file === "(data folder)");
    assert.equal(closed?.movedTo, join(root, "data-moved"));
  });
});

describe("应用关着期间记录文件被改：只告知，不恢复，以盘上为准", () => {
  test("关着时主文件被改：下次启动一条 changedWhileClosed，记录以盘上为准（不写回）", async () => {
    const first = open();
    await first.insert(makeAutomation({ id: "a" }));
    await first.insert(makeAutomation({ id: "b" }));
    await writeFile(join(dir, LIVE), JSON.stringify({ version: 1, automations: [] }), "utf8");
    const second = open();
    assert.deepEqual(await second.list(), []);
    assert.deepEqual(await kinds(), ["changedWhileClosed"]);
    const alert = (await second.archiveInfo()).alerts[0];
    assert.equal(alert?.file, LIVE);
    assert.deepEqual(await ids(LIVE), [], "没有恢复");
  });

  test("关着时主文件被删：同样一条", async () => {
    const first = open();
    await first.insert(makeAutomation({ id: "a" }));
    await rm(join(dir, LIVE));
    const second = open();
    await second.list();
    assert.deepEqual(await kinds(), ["changedWhileClosed"]);
  });

  test("正常关了又开（含 100 次写入后）不误报", async () => {
    const first = open();
    await first.insert(makeAutomation({ id: "a" }));
    for (let i = 0; i < 100; i += 1) await first.update("a", (c) => ({ ...c, runCount: c.runCount + 1 }));
    for (let i = 0; i < 5; i += 1) await open().list();
    assert.deepEqual(await kinds(), []);
  });

  test("写盘写到一半崩了（意图已留在镜像、文件没落成）不算被动过：新旧两份哈希都认", async () => {
    const first = open();
    await first.insert(makeAutomation({ id: "a" }));
    const before = await readFile(join(dir, LIVE), "utf8");
    // 模拟：文件已经是新内容（rename 落了）、但「写完」的那次指纹没来得及留——镜像里新旧哈希都在
    const next = before.replace('"runCount": 0', '"runCount": 1');
    assert.notEqual(next, before);
    const fingerprints = JSON.parse(await readFile(join(mirror, "fingerprints.json"), "utf8")) as { files: Record<string, string[]> };
    fingerprints.files[LIVE] = [...(fingerprints.files[LIVE] ?? []), createHash("sha256").update(next).digest("hex")];
    await writeFile(join(mirror, "fingerprints.json"), JSON.stringify(fingerprints), "utf8");
    await writeFile(join(dir, LIVE), next, "utf8");
    await open().list();
    assert.deepEqual(await kinds(), []);
  });
});
