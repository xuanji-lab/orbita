import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta } from "../../shared/session.ts";
import { DURABLE_MOVED_MESSAGE, durableKernelEnabled, KernelHost, markRunning, markSettled, routeFor } from "./kernel-host.ts";

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
  it("开着：根会话（含全新的）→ kernel；子会话 → 旧内核；迁移失败过 → 拒绝（只读）", () => {
    assert.deepEqual(routeFor(null, true), { to: "kernel" });
    assert.deepEqual(routeFor(meta(), true), { to: "kernel" });
    assert.deepEqual(routeFor(meta({ parentId: "root" }), true), { to: "legacy" });
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
    assert.deepEqual(markSettled({ since: 1, running: true }, { ok: false, reason: "shutdown", interrupted: true }, 9), { since: 1, running: true });
  });
});
