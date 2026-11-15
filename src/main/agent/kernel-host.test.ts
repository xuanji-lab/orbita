import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableMark, SessionMeta } from "../../shared/session.ts";
import { DURABLE_MOVED_MESSAGE, durableKernelEnabled, editRouteFor, KernelHost, legacyBookBytes, libraryRoot, markRunning, markSettled, routeFor, sessionsToResume } from "./kernel-host.ts";
import { awaitsContinue, restartNote, resumePolicy } from "../../shared/kernel.ts";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("durableKernelEnabled", () => {
  it("只认字面量 1", () => {
    assert.equal(durableKernelEnabled({ ORBITA_DURABLE_KERNEL: "1" }), true);
    for (const value of ["0", "", "true", "yes", " 1"]) assert.equal(durableKernelEnabled({ ORBITA_DURABLE_KERNEL: value }), false);
    assert.equal(durableKernelEnabled({}), false);
  });
});

describe("KernelHost", () => {
  it("drop：删库文件（含 WAL 旁文件），别的树不动；库不在也算成功；库名带路径拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-host-"));
    dirs.push(dir);
    for (const name of ["t.sqlite", "t.sqlite-wal", "t.sqlite-shm", "other.sqlite"]) await writeFile(join(dir, name), "x");
    const host = new KernelHost(dir);
    await host.drop("t.sqlite");
    assert.deepEqual(await readdir(dir), ["other.sqlite"]);
    await host.drop("never.sqlite");
    await assert.rejects(host.drop("../x.sqlite"));
  });
});

describe("routeFor / markRunning / markSettled：一轮交给谁、会话的新内核标记", () => {
  const meta = (extra: Partial<SessionMeta> = {}): SessionMeta => ({ id: "s", title: "", titleSource: "derived", cwd: "/", workspaceId: null, providerId: "p", modelId: "m", mode: "plan", thinkingLevel: "medium", piSessionFile: "/p.jsonl", pinned: false, archived: false, recentQueries: [], stats: null, createdAt: 1, updatedAt: 1, ...extra });
  it("开着：根会话（含全新的）与子会话 → kernel；迁移失败过 → 拒绝（只读）；本子编辑按住处分流", () => {
    assert.deepEqual(routeFor(null, true), { to: "kernel" });
    assert.deepEqual(routeFor(meta(), true), { to: "kernel" });
    // 子会话也交给新内核（与父同库，见 libraryRoot）
    assert.deepEqual(routeFor(meta({ parentId: "root" }), true), { to: "kernel" });
    assert.equal(libraryRoot(meta({ parentId: "root" }), "c1"), "root");
    assert.equal(libraryRoot(null, "s1"), "s1");
    // 本子编辑：住在新内核里的去 kernel（子会话带父的树根），还没跑过的旧会话旧内核，迁移失败过的拒绝
    assert.deepEqual(editRouteFor(meta(), "s1"), { to: "legacy" });
    assert.deepEqual(editRouteFor(meta({ durable: { since: 1 } }), "s1"), { to: "kernel", root: "s1" });
    assert.deepEqual(editRouteFor(meta({ parentId: "root", durable: { since: 1 } }), "c1"), { to: "kernel", root: "root" });
    assert.ok("refuse" in editRouteFor(meta({ durable: { since: 1, failed: "坏行" } }), "s1"));
    const refused = routeFor(meta({ durable: { since: 1, failed: "坏行" } }), true);
    assert.ok("refuse" in refused && refused.refuse.includes("坏行"));
  });
  it("关着：住在新内核里的会话拒绝（旧内核续写会两边分叉），其余旧内核", () => {
    assert.deepEqual(routeFor(meta(), false), { to: "legacy" });
    assert.deepEqual(routeFor(meta({ durable: { since: 1 } }), false), { refuse: DURABLE_MOVED_MESSAGE });
  });
  it("开轮置 running（第一次接手记 since）；落定清 running，迁移失败记原因", () => {
    assert.deepEqual(markRunning(undefined, 5), { since: 5, running: true });
    assert.deepEqual(markRunning({ since: 1 }, 5), { since: 1, running: true });
    assert.deepEqual(markSettled({ since: 1, running: true }, { ok: true, conversationId: 1, migration: "none", status: "done" }, 9), { since: 1 });
    assert.deepEqual(markSettled({ since: 1, running: true }, { ok: false, reason: "坏行", migrationFailed: true }, 9), { since: 1, failed: "坏行" });
    assert.deepEqual(markSettled({ since: 1, running: true }, { ok: false, reason: "网络" }, 9), { since: 1 });
    assert.deepEqual(markSettled({ since: 1, running: true }, { ok: false, reason: "shutdown", interrupted: true }, 9), { since: 1, running: true, stoppedOnQuit: true });
    // 下一轮开跑清掉「正常退出停的」标记（它只描述上一次中断）
    assert.deepEqual(markRunning({ since: 1, running: true, stoppedOnQuit: true }, 9), { since: 1, running: true });
  });
});

describe("重启后接着跑：只续子会话（后台任务），树根给「继续」", () => {
  const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ id, title: "", titleSource: "derived", cwd: "/", workspaceId: null, providerId: "p", modelId: "m", mode: "plan", thinkingLevel: "medium", piSessionFile: "/p.jsonl", pinned: false, archived: false, recentQueries: [], stats: null, createdAt: 1, updatedAt: 1, ...extra });
  it("正常退出停下的子会话续；崩溃留下的子会话、树根、没在跑的、迁移失败过的都不续", () => {
    const picked = sessionsToResume([
      meta("root", { durable: { since: 1, running: true, stoppedOnQuit: true } }),
      meta("child", { parentId: "root", durable: { since: 1, running: true, stoppedOnQuit: true } }),
      meta("crashed-child", { parentId: "root", durable: { since: 1, running: true } }),
      meta("idle-child", { parentId: "root", durable: { since: 1 } }),
      meta("failed-child", { parentId: "root", durable: { since: 1, running: true, failed: "坏行" } }),
      meta("legacy-child", { parentId: "root" }),
    ]);
    assert.deepEqual(picked.map((m) => m.id), ["child"]);
  });
  it("resumePolicy：拿不准（没有正常退出的标记）的子会话按崩溃处理；树根一律交给人", () => {
    assert.equal(resumePolicy({ parentId: "r", durable: { since: 1, running: true } }), "crashed");
    assert.equal(resumePolicy({ parentId: "r", durable: { since: 1, running: true, stoppedOnQuit: true } }), "resume");
    assert.equal(resumePolicy({ parentId: undefined, durable: { since: 1, running: true } }), "ask");
    assert.equal(resumePolicy({ parentId: undefined, durable: { since: 1, running: true, stoppedOnQuit: true } }), "ask");
    assert.equal(resumePolicy({ parentId: "r", durable: { since: 1 } }), null);
    assert.equal(resumePolicy({ parentId: "r", durable: { since: 1, running: true, failed: "坏" } }), null);
    assert.equal(resumePolicy({ parentId: "r" }), null);
  });
  it("resumed 只留给自动续跑的那一次 continue：人点的「继续」与下一次由人开的轮都清掉", () => {
    assert.deepEqual(markRunning({ since: 1, running: true, stoppedOnQuit: true, resumed: 5 }, 9, true), { since: 1, resumed: 5, running: true });
    // 崩溃后人点「继续」：也是 continue，但上一轮不是正常退出停的——resumed 是更早那次的旧账
    assert.deepEqual(markRunning({ since: 1, running: true, resumed: 5 }, 9, true), { since: 1, running: true });
    assert.deepEqual(markRunning({ since: 1, resumed: 5 }, 9), { since: 1, running: true });
  });
  it("先正常退出重启（自动续跑）→ 续跑中崩溃重启 → 点继续 → 跑完：面板每一刻只说一句，点了继续不再说旧的", () => {
    const child = (durable: DurableMark): Pick<SessionMeta, "parentId" | "durable"> => ({ parentId: "root", durable });
    // 子会话在跑 → 正常退出：停下的轮落定为 interrupted
    let mark = markSettled(markRunning(undefined, 1), { ok: false, reason: "shutdown", interrupted: true }, 2);
    assert.equal(resumePolicy(child(mark)), "resume");
    // 重启：index.ts 先记 resumed，再走 continue 的开轮（route 的 markRunning）
    mark = markRunning({ ...mark, resumed: 3 }, 3, true);
    assert.equal(restartNote(child(mark), true), "resumed", "自动续跑那一轮在跑：说「已自动接着跑」，不说被打断");
    // 续跑那一轮里崩溃：什么都写不上，meta 停在 { resumed, running }
    assert.equal(resumePolicy(child(mark)), "crashed");
    assert.equal(restartNote(child(mark), false), "crashed", "崩溃压过旧的 resumed：只说「被打断了 · 继续」");
    assert.equal(awaitsContinue(child(mark), false), true);
    // 人点「继续」：在跑——不再等你；跑完落定：两句都不说
    mark = markRunning(mark, 4, true);
    assert.equal(awaitsContinue(child(mark), true), false);
    assert.equal(restartNote(child(mark), true), null, "点了继续之后不再说「已自动接着跑」");
    mark = markSettled(mark, { ok: true, conversationId: 1, migration: "none", status: "done" }, 5);
    assert.equal(restartNote(child(mark), false), null);
    assert.equal(awaitsContinue(child(mark), false), false);
  });
  it("awaitsContinue：只有崩溃留下、此刻没在跑的子会话等你；正常退出待续跑的、树根、在跑的都不算", () => {
    assert.equal(awaitsContinue({ parentId: "r", durable: { since: 1, running: true } }, false), true);
    assert.equal(awaitsContinue({ parentId: "r", durable: { since: 1, running: true } }, true), false);
    assert.equal(awaitsContinue({ parentId: "r", durable: { since: 1, running: true, stoppedOnQuit: true } }, false), false);
    assert.equal(awaitsContinue({ parentId: undefined, durable: { since: 1, running: true } }, false), false);
    assert.equal(awaitsContinue({ parentId: "r", durable: { since: 1 } }, false), false);
  });
});

describe("legacyBookBytes：这一轮要迁的旧本子多大（大的发送那一刻就说正在迁移）", () => {
  it("还没在新内核里跑过、有旧本子：本子的字节数；已在新内核里 / 新内核里新建的 / 没有本子 / 本子读不到：null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-host-"));
    const book = join(dir, "book.jsonl");
    await writeFile(book, "x".repeat(1234));
    assert.equal(await legacyBookBytes({ piSessionFile: book }), 1234);
    assert.equal(await legacyBookBytes({ piSessionFile: book, durable: { since: 1 } }), null);
    assert.equal(await legacyBookBytes({ piSessionFile: "durable:s1" }), null);
    assert.equal(await legacyBookBytes({ piSessionFile: null }), null);
    assert.equal(await legacyBookBytes({ piSessionFile: join(dir, "missing.jsonl") }), null);
    assert.equal(await legacyBookBytes(null), null);
    await rm(dir, { recursive: true, force: true });
  });
});
