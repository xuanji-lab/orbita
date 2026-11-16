import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainAgentStore, mainAgentOf } from "./main-agent.ts";
import type { SessionMeta } from "../../shared/session.ts";

async function fresh(): Promise<{ dir: string; store: MainAgentStore; ids: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "main-agent-"));
  let n = 0;
  const ids: string[] = [];
  const store = new MainAgentStore(join(dir, "agents", "main"), {
    now: () => 1000,
    newId: () => {
      const id = `s${++n}`;
      ids.push(id);
      return id;
    },
  });
  return { dir, store, ids };
}

describe("MainAgentStore —— 每个工作区一份主智能体档案", () => {
  test("第一次 ensure 建档案并原子落盘，之后读回同一份；并发的第一次只建一份", async () => {
    const { dir, store, ids } = await fresh();
    const [a, b] = await Promise.all([store.ensure("w1"), store.ensure("w1")]);
    assert.deepEqual(a, { workspaceId: "w1", sessionId: "s1", createdAt: 1000 });
    assert.deepEqual(b, a);
    assert.deepEqual(ids, ["s1"]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "agents", "main", "w1.json"), "utf8")), a);
    assert.deepEqual(await store.ensure("w1"), a);
    assert.equal((await store.ensure("w2")).sessionId, "s2");
    await rm(dir, { recursive: true, force: true });
  });

  test("坏文件当没有、重建；越出目录的工作区 id 拒绝", async () => {
    const { dir, store } = await fresh();
    await mkdir(join(dir, "agents", "main"), { recursive: true });
    await writeFile(join(dir, "agents", "main", "w1.json"), "{not json");
    assert.equal((await store.ensure("w1")).sessionId, "s1");
    await assert.rejects(store.ensure("../x"));
    assert.equal(await store.isMain("s1", "../x"), false);
    await rm(dir, { recursive: true, force: true });
  });

  test("isMain 认档案；forget 只删指向这条会话的档案，删后重新预留新 id", async () => {
    const { dir, store } = await fresh();
    await store.ensure("w1");
    assert.equal(await store.isMain("s1", "w1"), true);
    assert.equal(await store.isMain("s1", "w2"), false);
    assert.equal(await store.isMain("s1", null), false);
    await store.forget("w1", "other");
    assert.equal(await store.isMain("s1", "w1"), true);
    await store.forget("w1", "s1");
    assert.equal((await store.ensure("w1")).sessionId, "s2");
    await rm(dir, { recursive: true, force: true });
  });

  test("mainAgentOf：会话已落盘却没带 role 就补上（档案是真源）；会话还没建不动", async () => {
    const { dir, store } = await fresh();
    const roles: string[] = [];
    const metas = new Map<string, Partial<SessionMeta>>();
    const sessions = {
      readMeta: async (id: string) => (metas.get(id) as SessionMeta | undefined) ?? null,
      setRole: async (id: string) => {
        roles.push(id);
      },
    };
    await mainAgentOf(store, sessions, "w1");
    assert.deepEqual(roles, []);
    metas.set("s1", { id: "s1" });
    await mainAgentOf(store, sessions, "w1");
    assert.deepEqual(roles, ["s1"]);
    metas.set("s1", { id: "s1", role: "main" });
    await mainAgentOf(store, sessions, "w1");
    assert.deepEqual(roles, ["s1"]);
    await rm(dir, { recursive: true, force: true });
  });
});
