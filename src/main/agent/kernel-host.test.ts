import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelCommand, KernelMessage, KernelOpenResult, SessionDurable } from "../../shared/kernel.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { durableKernelEnabled, KernelHost, openInKernel, type KernelChild, type KernelOpenDeps } from "./kernel-host.ts";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: "",
    titleSource: "derived",
    cwd: "/w",
    workspaceId: null,
    providerId: "p",
    modelId: "m",
    mode: "plan",
    thinkingLevel: "medium",
    piSessionFile: `/pi/${id}.jsonl`,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function deps(result: KernelOpenResult, metas: SessionMeta[] = []): KernelOpenDeps & { opened: unknown[]; written: [string, SessionDurable][]; notified: string[] } {
  const opened: unknown[] = [];
  const written: [string, SessionDurable][] = [];
  const notified: string[] = [];
  return {
    opened,
    written,
    notified,
    host: {
      open: async (input) => {
        opened.push(input);
        return result;
      },
    },
    readMeta: async (id) => metas.find((item) => item.id === id) ?? null,
    resolveProvider: async () => {
      throw new Error("provider disabled");
    },
    compaction: async () => ({ enabled: true, reservePercent: 20 }),
    setDurable: async (id, durable) => {
      written.push([id, durable]);
    },
    notifyFailure: (_id, message) => notified.push(message),
    now: () => 42,
  };
}

describe("durableKernelEnabled", () => {
  it("只认字面量 1", () => {
    assert.equal(durableKernelEnabled({}), false);
    assert.equal(durableKernelEnabled({ ORBITA_DURABLE_KERNEL: "0" }), false);
    assert.equal(durableKernelEnabled({ ORBITA_DURABLE_KERNEL: "true" }), false);
    assert.equal(durableKernelEnabled({ ORBITA_DURABLE_KERNEL: "1" }), true);
  });
});

describe("openInKernel", () => {
  const ok: KernelOpenResult = { ok: true, conversationId: 7, migrated: true, entries: 3, legacy: { bytes: 10, mtimeMs: 5 }, ms: 1 };

  it("子会话进树根的库；装配不了服务商就不配模型（不拦迁移）", async () => {
    const root = meta("root");
    const child = meta("child", { parentId: "root" });
    const d = deps(ok, [root, child]);
    const durable = await openInKernel(d, child);
    assert.deepEqual(durable, { status: "ready", library: "root.sqlite", conversationId: 7, migratedAt: 42, legacy: { bytes: 10, mtimeMs: 5 } });
    const sent = d.opened[0] as Extract<KernelCommand, { type: "open" }>;
    assert.equal(sent.library, "root.sqlite");
    assert.equal(sent.agent.provider, null);
    assert.equal(sent.agent.role, "child");
    assert.deepEqual(sent.legacy, { piSessionFile: "/pi/child.jsonl" });
    assert.deepEqual(d.written, [["child", durable]]);
  });

  it("库里已有、meta 也记着同一个位置：不重写 meta", async () => {
    const recorded: SessionDurable = { status: "ready", library: "s.sqlite", conversationId: 7, migratedAt: 1, legacy: null };
    const d = deps({ ...ok, migrated: false, entries: 0, legacy: null }, []);
    const durable = await openInKernel(d, meta("s", { durable: recorded }));
    assert.deepEqual(durable, recorded);
    assert.deepEqual(d.written, []);
  });

  it("失败：meta 记原因、窗口里报一句", async () => {
    const d = deps({ ok: false, reason: "pi 本子里有认不出的内容" });
    const durable = await openInKernel(d, meta("s"));
    assert.deepEqual(durable, { status: "failed", reason: "pi 本子里有认不出的内容", at: 42 });
    assert.equal(d.notified.length, 1);
    assert.match(d.notified[0] ?? "", /原记录没有改动/);
  });

  it("没有 pi 本子的会话不碰", async () => {
    const d = deps(ok);
    assert.equal(await openInKernel(d, meta("s", { piSessionFile: null })), null);
    assert.equal(d.opened.length, 0);
  });

  it("parentId 成环不死循环", async () => {
    const a = meta("a", { parentId: "b" });
    const b = meta("b", { parentId: "a" });
    const d = deps(ok, [a, b]);
    const durable = await openInKernel(d, a);
    assert.equal(durable?.status, "ready");
  });
});

describe("KernelHost", () => {
  function fakeChild(): { child: KernelChild; sent: KernelCommand[]; emit: (message: KernelMessage) => void; exit: (code: number) => void } {
    const sent: KernelCommand[] = [];
    const listeners: { message: ((message: KernelMessage) => void)[]; exit: ((code: number) => void)[] } = { message: [], exit: [] };
    const child: KernelChild = {
      postMessage: (message) => sent.push(message),
      on: (event: "message" | "exit", listener: ((message: KernelMessage) => void) | ((code: number) => void)) => {
        if (event === "message") listeners.message.push(listener as (message: KernelMessage) => void);
        else listeners.exit.push(listener as (code: number) => void);
        return undefined;
      },
    };
    return {
      child,
      sent,
      emit: (message) => listeners.message.forEach((listener) => listener(message)),
      exit: (code) => listeners.exit.forEach((listener) => listener(code)),
    };
  }

  it("懒启动：第一次 open 才 fork，先发 init；回执按 requestId 结", async () => {
    const fake = fakeChild();
    let forks = 0;
    const host = new KernelHost(() => {
      forks += 1;
      return fake.child;
    }, "/data/durable");
    assert.equal(forks, 0);
    const pending = host.open({ library: "a.sqlite", sessionId: "a", legacy: null, agent: { provider: null, modelId: "m", thinkingLevel: "off", cwd: "/", role: "root", compaction: { enabled: true, reservePercent: 20 } } });
    assert.equal(forks, 1);
    assert.deepEqual(fake.sent[0], { type: "init", dir: "/data/durable" });
    const command = fake.sent[1] as Extract<KernelCommand, { type: "open" }>;
    fake.emit({ type: "opened", requestId: command.requestId, sessionId: "a", result: { ok: true, conversationId: 1, migrated: false, entries: 0, legacy: null, ms: 0 } });
    assert.deepEqual(await pending, { ok: true, conversationId: 1, migrated: false, entries: 0, legacy: null, ms: 0 });
  });

  it("进程没了：在等的 open 折成失败，下次再拉", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const host = new KernelHost(() => children.shift()!.child, "/d");
    const agent = { provider: null, modelId: "m", thinkingLevel: "off" as const, cwd: "/", role: "root" as const, compaction: { enabled: true, reservePercent: 20 } };
    const pending = host.open({ library: "a.sqlite", sessionId: "a", legacy: null, agent });
    first.exit(9);
    const result = await pending;
    assert.equal(result.ok, false);
    void host.open({ library: "a.sqlite", sessionId: "a", legacy: null, agent });
    assert.equal(second.sent[0]?.type, "init");
  });

  it("drop：kernel 进程没起时直接删库文件（含 WAL 旁文件），不拉进程；库名带路径拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-host-"));
    dirs.push(dir);
    for (const name of ["t.sqlite", "t.sqlite-wal", "t.sqlite-shm", "other.sqlite"]) await writeFile(join(dir, name), "x");
    const host = new KernelHost(() => {
      throw new Error("should not fork");
    }, dir);
    await host.drop("t.sqlite");
    assert.deepEqual(await readdir(dir), ["other.sqlite"]);
    await host.drop("never.sqlite");
    await assert.rejects(host.drop("../x.sqlite"));
  });
});
