import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentCommand } from "../../shared/agent-ipc.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { familyOf, moveSessions, type MoveDeps } from "./move.ts";

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    titleSource: "user",
    cwd: "/old",
    workspaceId: "w-old",
    piSessionFile: `/pi/${id}.jsonl`,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    providerId: "p",
    modelId: "m",
    mode: "ask",
    thinkingLevel: "medium",
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as SessionMeta;
}

const target: Workspace = { id: "w-new", name: "new", path: "/new", createdAt: 0, attachedDirs: [] };

interface Harness {
  deps: MoveDeps;
  metas: Map<string, SessionMeta>;
  edits: Extract<AgentCommand, { type: "movePiBook" }>[];
}

function harness(
  list: SessionMeta[],
  options: { running?: string[]; failEditFor?: string } = {},
): Harness {
  const metas = new Map(list.map((m) => [m.id, { ...m }]));
  const edits: Harness["edits"] = [];
  const deps: MoveDeps = {
    sessions: {
      list: () => Promise.resolve([...metas.values()]),
      relocate: (id, workspaceId, cwd) => {
        const current = metas.get(id);
        if (current !== undefined) metas.set(id, { ...current, workspaceId, cwd });
        return Promise.resolve();
      },
    },
    workspaces: { list: () => Promise.resolve([target]), defaultPath: () => "/home" },
    host: {
      editPiBook: (command) => {
        if (command.sessionId === options.failEditFor) return Promise.reject(new Error("boom"));
        edits.push(command);
        return Promise.resolve();
      },
    },
    isRunning: (id) => options.running?.includes(id) ?? false,
  };
  return { deps, metas, edits };
}

describe("moveSessions", () => {
  test("归属与 cwd 一起换，cwd 变了的往 pi 本子写通知（用新目录开）", async () => {
    const h = harness([meta("a"), meta("b")]);
    const result = await moveSessions(h.deps, ["a", "b"], "w-new");
    assert.deepEqual(result, { moved: ["a", "b"], skipped: [] });
    assert.equal(h.metas.get("a")?.cwd, "/new");
    assert.equal(h.metas.get("a")?.workspaceId, "w-new");
    assert.deepEqual(
      h.edits.map((e) => [e.sessionId, e.cwd, e.sourcePiSessionFile]),
      [
        ["a", "/new", "/pi/a.jsonl"],
        ["b", "/new", "/pi/b.jsonl"],
      ],
    );
    assert.ok(h.edits[0]?.notice.includes("from /old to /new"));
  });

  test("移回 TASKS：cwd 换成 Home", async () => {
    const h = harness([meta("a")]);
    await moveSessions(h.deps, ["a"], null);
    assert.equal(h.metas.get("a")?.workspaceId, null);
    assert.equal(h.metas.get("a")?.cwd, "/home");
  });

  test("cwd 没变或没有 pi 本子：只写 meta，不写通知", async () => {
    const h = harness([meta("same", { cwd: "/new" }), meta("fresh", { piSessionFile: null })]);
    const result = await moveSessions(h.deps, ["same", "fresh"], "w-new");
    assert.deepEqual(result.moved, ["same", "fresh"]);
    assert.equal(h.edits.length, 0);
    assert.equal(h.metas.get("fresh")?.cwd, "/new");
  });

  test("子会话（多层）随母会话一起搬；同批里又点了子会话不重复", async () => {
    const h = harness([meta("root"), meta("child", { parentId: "root" }), meta("grand", { parentId: "child" })]);
    const result = await moveSessions(h.deps, ["root", "child"], "w-new");
    assert.deepEqual(result.moved, ["root", "child", "grand"]);
    assert.equal(h.metas.get("grand")?.cwd, "/new");
    assert.equal(h.edits.length, 3);
  });

  test("自己或子会话在跑：整家跳过、一字不改，别的照搬", async () => {
    const h = harness([meta("busy"), meta("kid", { parentId: "busy" }), meta("idle")], { running: ["kid"] });
    const result = await moveSessions(h.deps, ["busy", "idle"], "w-new");
    assert.deepEqual(result, { moved: ["idle"], skipped: [{ id: "busy", reason: "running" }] });
    assert.equal(h.metas.get("busy")?.cwd, "/old");
    assert.equal(h.metas.get("kid")?.cwd, "/old");
  });

  test("通知写失败：这条 meta 不动（通知先于 meta），记 failed，不拖累下一条", async () => {
    const h = harness([meta("bad"), meta("good")], { failEditFor: "bad" });
    const result = await moveSessions(h.deps, ["bad", "good"], "w-new");
    assert.deepEqual(result, { moved: ["good"], skipped: [{ id: "bad", reason: "failed" }] });
    assert.equal(h.metas.get("bad")?.cwd, "/old");
    assert.equal(h.metas.get("bad")?.workspaceId, "w-old");
  });

  test("不存在的会话记 missing；不存在的工作区整批拒绝", async () => {
    const h = harness([meta("a")]);
    assert.deepEqual(await moveSessions(h.deps, ["ghost"], "w-new"), {
      moved: [],
      skipped: [{ id: "ghost", reason: "missing" }],
    });
    await assert.rejects(moveSessions(h.deps, ["a"], "w-gone"), /工作区不存在/);
    assert.equal(h.metas.get("a")?.cwd, "/old");
  });
});

describe("familyOf", () => {
  test("根在最前，后代按层收；根不在返回空", () => {
    const all = [meta("c", { parentId: "r" }), meta("r"), meta("x")];
    assert.deepEqual(
      familyOf("r", all).map((m) => m.id),
      ["r", "c"],
    );
    assert.deepEqual(familyOf("nope", all), []);
  });
});
