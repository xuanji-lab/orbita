import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { MobileCatalog, type CatalogDeps } from "./summaries.ts";
import type { SessionSummary } from "../../shared/mobile.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const metaOf = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `任务 ${id.slice(0, 4)}`,
  titleSource: "auto",
  cwd: "/repo/orbita",
  workspaceId: "ws-1",
  providerId: "zai",
  modelId: "glm-5.3",
  thinkingLevel: "high",
  piSessionFile: "/data/pi-sessions/x.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: NOW - 10 * DAY,
  updatedAt: NOW - DAY,
  ...patch,
});

const said = (id: string, at: number, text: string): TranscriptItem => ({
  id,
  role: "assistant",
  timestamp: at,
  status: "complete",
  stopReason: "stop",
  model: { provider: "p", id: "m" },
  content: [{ type: "text", text }],
});

const planRecord = (id: string, at: number, awaiting: boolean): TranscriptItem => ({
  id,
  role: "tool",
  timestamp: at,
  toolCallId: id,
  toolName: "update_plan",
  input: {},
  content: [],
  status: "complete",
  isError: false,
  details: { awaiting },
});

interface World {
  metas: SessionMeta[];
  tails: Map<string, SessionRecord[]>;
  stats: Map<string, { size: number; mtimeMs: number }>;
  phases: Map<string, string>;
  tailReads: string[];
}

function depsOf(world: World): CatalogDeps {
  return {
    listMetas: () => Promise.resolve(world.metas),
    listWorkspaces: () => Promise.resolve([{ id: "ws-1", name: "璇玑" }]),
    tailRecords: (id) => {
      world.tailReads.push(id);
      return Promise.resolve(world.tails.get(id) ?? []);
    },
    tailStat: (id) => Promise.resolve(world.stats.get(id) ?? null),
    phaseOf: (id) => world.phases.get(id),
    now: () => NOW,
  };
}

function worldOf(metas: SessionMeta[]): World {
  const world: World = { metas, tails: new Map(), stats: new Map(), phases: new Map(), tailReads: [] };
  for (const meta of metas) {
    world.tails.set(meta.id, []);
    world.stats.set(meta.id, { size: 100, mtimeMs: 1 });
  }
  return world;
}

const byId = (sessions: SessionSummary[], id: string): SessionSummary => {
  const found = sessions.find((session) => session.id === id);
  assert.ok(found !== undefined, `清单里应该有 ${id}`);
  return found;
};

describe("sessions.list：清单的构建", () => {
  test("只列根会话：子会话、自动化新开的、归档的都不列；30 天窗口；倒序；truncated", async () => {
    const roots: SessionMeta[] = [];
    for (let i = 0; i < 205; i += 1) roots.push(metaOf(`00000000-0000-7000-8000-${String(i).padStart(12, "0")}`, { updatedAt: NOW - (i + 1) * 1000 }));
    const world = worldOf([
      ...roots,
      metaOf("10000000-0000-7000-8000-000000000001", { parentId: roots[0]?.id }), // 子会话
      metaOf("10000000-0000-7000-8000-000000000002", { automationId: "auto-1" }), // 自动化新开
      metaOf("10000000-0000-7000-8000-000000000003", { automationId: "auto-1", promoted: true, updatedAt: NOW + 1000 }), // 转成普通会话，最新
      metaOf("10000000-0000-7000-8000-000000000004", { archived: true, updatedAt: NOW }), // 归档
      metaOf("10000000-0000-7000-8000-000000000005", { updatedAt: NOW - 31 * DAY }), // 过了 30 天窗
    ]);
    const catalog = new MobileCatalog(depsOf(world));
    const { sessions, truncated } = await catalog.list();
    assert.equal(truncated, true);
    assert.equal(sessions.length, 200);
    // 最新动过的排最前（promoted 的自动化会话 updatedAt 比所有根会话都新）
    assert.equal(sessions[0]?.id, "10000000-0000-7000-8000-000000000003");
    assert.ok(!sessions.some((s) => s.id === "10000000-0000-7000-8000-000000000001"), "子会话不列");
    assert.ok(!sessions.some((s) => s.id === "10000000-0000-7000-8000-000000000002"), "自动化新开的会话不列");
    assert.ok(!sessions.some((s) => s.id === "10000000-0000-7000-8000-000000000004"), "归档不列");
    assert.ok(!sessions.some((s) => s.id === "10000000-0000-7000-8000-000000000005"), "过窗不列");
  });

  test("状态推导、lastLine、工作区名、子会话在跑数", async () => {
    const running = metaOf("20000000-0000-7000-8000-000000000001", { updatedAt: NOW - 1000 });
    const waiting = metaOf("20000000-0000-7000-8000-000000000002");
    const unreadDone = metaOf("20000000-0000-7000-8000-000000000003", { unread: { at: 5, failed: false } });
    const unreadFailed = metaOf("20000000-0000-7000-8000-000000000004", { unread: { at: 5, failed: true } });
    const child = metaOf("20000000-0000-7000-8000-00000000000c", { parentId: running.id });
    const world = worldOf([running, waiting, unreadDone, unreadFailed, child]);
    world.phases.set(running.id, "turn");
    world.phases.set(child.id, "turn");
    world.tails.set(running.id, [said("r1", 10, "第一行\n第二行")]);
    world.tails.set(waiting.id, [planRecord("p1", 10, true)]);
    const catalog = new MobileCatalog(depsOf(world));
    const { sessions } = await catalog.list();
    assert.equal(byId(sessions, running.id).state, "running");
    assert.equal(byId(sessions, running.id).lastLine, "第一行");
    assert.equal(byId(sessions, running.id).workspaceName, "璇玑");
    assert.equal(byId(sessions, running.id).childrenRunning, 1);
    assert.equal(byId(sessions, waiting.id).state, "waiting");
    assert.equal(byId(sessions, unreadDone.id).state, "done");
    assert.equal(byId(sessions, unreadFailed.id).state, "failed");
  });

  test("尾部一次最多读 40 条；其余沿用缓存或留空；文件没变不重读", async () => {
    const metas: SessionMeta[] = [];
    for (let i = 0; i < 45; i += 1) metas.push(metaOf(`30000000-0000-7000-8000-${String(i).padStart(12, "0")}`, { updatedAt: NOW - i * 1000 }));
    const world = worldOf(metas);
    for (const meta of metas) world.tails.set(meta.id, [said(`s-${meta.id}`, 10, `第 ${meta.id.slice(-2)} 条`)]);
    const catalog = new MobileCatalog(depsOf(world));
    const first = await catalog.list();
    assert.equal(world.tailReads.length, 40, "一次清单刷新最多读 40 个尾部");
    assert.equal(byId(first.sessions, metas[0]?.id ?? "").lastLine, "第 00 条");
    assert.equal(byId(first.sessions, metas[44]?.id ?? "").lastLine, null, "超预算的留空");
    // 第二轮把没读过的 5 条补上（渐进回填）；第三轮全都命中缓存，一个都不再读
    world.tailReads.length = 0;
    const second = await catalog.list();
    assert.equal(world.tailReads.length, 5);
    assert.equal(byId(second.sessions, metas[44]?.id ?? "").lastLine, "第 44 条");
    world.tailReads.length = 0;
    await catalog.list();
    assert.equal(world.tailReads.length, 0);
    // 变了一条：mtime 变了，只重读它
    const touched = metas[1]?.id ?? "";
    world.stats.set(touched, { size: 101, mtimeMs: 2 });
    world.tails.set(touched, [said("r2", 11, "新的最近一句")]);
    const third = await catalog.list();
    assert.deepEqual(world.tailReads, [touched]);
    assert.equal(byId(third.sessions, touched).lastLine, "新的最近一句");
  });
});

describe("sessions.changed：增量推送", () => {
  const A = "40000000-0000-7000-8000-00000000000a";
  const B = "40000000-0000-7000-8000-00000000000b";

  function flushAfter(catalog: MobileCatalog): Promise<void> {
    void catalog;
    // 脏标记攒 400ms；测试里等它真的 flush
    return new Promise((resolve) => setTimeout(resolve, 500));
  }

  test("watch 后第一次推送是全量；之后只带变过的；删除推 removed", async () => {
    const world = worldOf([metaOf(A), metaOf(B)]);
    const catalog = new MobileCatalog(depsOf(world));
    await catalog.list();
    const pushes: { changed: SessionSummary[]; removed: string[] }[] = [];
    catalog.subscribe((changed, removed) => pushes.push({ changed, removed }));
    // 一条事件都不来时不推
    await flushAfter(catalog);
    assert.equal(pushes.length, 0);
    // B 的 phase 变了 → 第一次推送是全量（两条都在）
    world.phases.set(B, "turn");
    catalog.onAgentEvent({ type: "phase", sessionId: B, phase: "turn" } as AgentEvent);
    await flushAfter(catalog);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]?.changed.length, 2);
    assert.equal(byId(pushes[0]?.changed ?? [], B).state, "running");
    // A 的 meta 变了（标题）→ 只带 A
    pushes.length = 0;
    world.metas = world.metas.map((meta) => (meta.id === A ? { ...meta, title: "新标题", updatedAt: NOW } : meta));
    catalog.onAgentEvent({ type: "title", sessionId: A, title: "新标题" } as AgentEvent);
    await flushAfter(catalog);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]?.changed.length, 1);
    assert.equal(pushes[0]?.changed[0]?.title, "新标题");
    // B 被删 → removed
    pushes.length = 0;
    world.metas = world.metas.filter((meta) => meta.id !== B);
    catalog.onAgentEvent({ type: "title", sessionId: B, title: "x" } as AgentEvent);
    await flushAfter(catalog);
    assert.equal(pushes.length, 1);
    assert.deepEqual(pushes[0]?.removed, [B]);
  });

  test("跑完没看：idle 之后是 done，unread.clear 之后回 idle", async () => {
    const world = worldOf([metaOf(A)]);
    const catalog = new MobileCatalog(depsOf(world));
    await catalog.list();
    const pushes: { changed: SessionSummary[]; removed: string[] }[] = [];
    catalog.subscribe((changed, removed) => pushes.push({ changed, removed }));
    // 跑起来再停：从在跑变空闲。事件到达时运行态表还是旧值（订阅点在泵的入口），
    // flush 时才读新值——所以先在表里留着 turn 发 idle 事件，再改成没在跑
    world.phases.set(A, "turn");
    catalog.onAgentEvent({ type: "phase", sessionId: A, phase: "turn" } as AgentEvent);
    await flushAfter(catalog);
    catalog.onAgentEvent({ type: "phase", sessionId: A, phase: "idle" } as AgentEvent);
    world.phases.delete(A);
    await flushAfter(catalog);
    const last = pushes.at(-1)?.changed.find((s) => s.id === A);
    assert.equal(last?.state, "done", "跑完没看");
    // unread.clear：回到 idle
    catalog.clearSettled(A);
    await flushAfter(catalog);
    assert.equal(pushes.at(-1)?.changed.find((s) => s.id === A)?.state, "idle");
    // 之后再收到 idle 事件：没有变化就不推（settledRecently 没有被误标）
    pushes.length = 0;
    catalog.onAgentEvent({ type: "phase", sessionId: A, phase: "idle" } as AgentEvent);
    await flushAfter(catalog);
    assert.equal(pushes.length, 0);
  });
});
