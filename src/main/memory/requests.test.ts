/**
 * IPC 胶水的回归网：作用域由主进程按会话归属解析（workspaceId ?? cwd），
 * 读不到 meta 时「没有可注入的」而不是报错，append 与 retrieve 走同一条作用域。
 * store 用真的（临时目录），会话存储用 stub——这里测的是接线，不是落盘。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { applyMemoryAppend, applyMemoryRetrieve, parseMemoryRemoveRequest, parseMemoryScopeRef, type SessionScopeReader } from "./requests.ts";
import { MemoryStore } from "./store.ts";

/** 时间戳要贴近「现在」：衰减半衰期 180 天，用 epoch 0 之类的老时间戳会被衰减判负。 */
const NOW = Date.now();

let dir = "";
let memory: MemoryStore;

/** 会话归属的 stub：两条会话，一条在工作区里，一条只有 cwd，还有一条查无此会话。 */
class FakeSessions implements SessionScopeReader {
  readonly asked: string[] = [];

  async readMeta(id: string): Promise<{ workspaceId: string | null; cwd: string } | null> {
    this.asked.push(id);
    if (id === "in-workspace") return { workspaceId: "ws-a", cwd: "C:/elsewhere" };
    if (id === "no-workspace") return { workspaceId: null, cwd: "C:/work/project" };
    return null;
  }
}

const retrieve = (sessionId: string, query: string): Extract<AgentEvent, { type: "memoryRetrieveRequest" }> => ({
  type: "memoryRetrieveRequest",
  requestId: "r1",
  sessionId,
  query,
});

const append = (
  sessionId: string,
  entries: { text: string; keywords: string[]; timestamp: number }[],
): Extract<AgentEvent, { type: "memoryAppend" }> => ({ type: "memoryAppend", sessionId, entries });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-memory-ipc-"));
  memory = new MemoryStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyMemoryAppend", () => {
  test("按会话归属落进对应作用域：工作区里的会话与只有 cwd 的会话不互通", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", [
      { text: "用户偏好用 bun 作为包管理器", keywords: ["bun", "包管理器"], timestamp: NOW },
    ]));
    await applyMemoryAppend(sessions, memory, append("no-workspace", [
      { text: "用户偏好用 bun 作为包管理器", keywords: ["bun", "包管理器"], timestamp: NOW - 60_000 },
    ]));
    await applyMemoryAppend(sessions, memory, append("gone", [
      { text: "会话已删，无处可落", keywords: ["bun"], timestamp: NOW },
    ]));

    // ws-a 与 C:/work/project 各一份，互不看见；gone 那条静默丢弃（只记日志，不抛）
    assert.deepEqual(
      (await memory.list("ws-a")).map((entry) => entry.sessionId),
      ["in-workspace"],
    );
    assert.deepEqual(
      (await memory.list("C:/work/project")).map((entry) => entry.sessionId),
      ["no-workspace"],
    );
  });

  test("0 条 draft 不碰盘", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", []));
    assert.deepEqual(await memory.list("ws-a"), []);
  });
});

describe("applyMemoryRetrieve", () => {
  test("召回的是这条会话所在作用域的记忆", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", [
      { text: "用户偏好用 bun 作为包管理器，禁用 npm", keywords: ["bun", "包管理器"], timestamp: NOW },
    ]));
    await applyMemoryAppend(sessions, memory, append("no-workspace", [
      { text: "终端面板默认字号 13px", keywords: ["字号"], timestamp: NOW },
    ]));

    const mine = await applyMemoryRetrieve(sessions, memory, retrieve("in-workspace", "包管理器用什么"));
    assert.equal(mine.ok, true);
    if (!mine.ok) return;
    assert.equal(mine.hits.length, 1);
    assert.equal(mine.hits[0]?.entry.text, "用户偏好用 bun 作为包管理器，禁用 npm");
  });

  test("读不到会话 meta = 没有可注入的（ok: true 配空 hits），不抛", async () => {
    const sessions = new FakeSessions();
    const outcome = await applyMemoryRetrieve(sessions, memory, retrieve("gone", "包管理器"));
    assert.deepEqual(outcome, { ok: true, hits: [] });
  });

  test("空库 / 无命中都是 ok: true 配空 hits", async () => {
    const sessions = new FakeSessions();
    assert.deepEqual(await applyMemoryRetrieve(sessions, memory, retrieve("in-workspace", "包管理器")), {
      ok: true,
      hits: [],
    });
    await applyMemoryAppend(sessions, memory, append("in-workspace", [
      { text: "用户喜欢深色主题", keywords: ["主题"], timestamp: NOW },
    ]));
    assert.deepEqual(await applyMemoryRetrieve(sessions, memory, retrieve("in-workspace", "端口号是多少")), {
      ok: true,
      hits: [],
    });
  });
});

describe("event.scope 优先（首轮竞态回归：meta 未落盘也要能召回）", () => {
  test("带 scope 的请求不读 meta，首轮即可召回", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", [
      { text: "用户养了一只叫「雪球」的橘猫", keywords: ["雪球", "猫"], timestamp: NOW },
    ]));
    // "gone" 查无此会话（meta 还没落盘的首轮）；但请求带了开轮命令里的 scope
    const outcome = await applyMemoryRetrieve(sessions, memory, {
      ...retrieve("gone", "我的猫叫什么名字"),
      scope: { workspaceId: "ws-a", cwd: "C:/elsewhere" },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.hits.length, 1);
    // 只有 append 问过一次 meta；带 scope 的召回没有再问——竞态从根上消失
    assert.deepEqual(sessions.asked, ["in-workspace"]);
  });

  test("scope 缺席时退回 meta 解析（旧调用方兼容）", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", [
      { text: "项目 dev 端口固定 5273", keywords: ["端口"], timestamp: NOW },
    ]));
    const outcome = await applyMemoryRetrieve(sessions, memory, retrieve("in-workspace", "端口是多少"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.hits.length, 1);
    // append 一次 + 退回 meta 的召回一次
    assert.deepEqual(sessions.asked, ["in-workspace", "in-workspace"]);
  });
});

describe("设置 › 记忆的入参校验（renderer 那头什么都能传）", () => {
  test("parseMemoryScopeRef 收下工作区引用与纯 cwd 引用", () => {
    assert.deepEqual(parseMemoryScopeRef({ workspaceId: "ws-a", cwd: "C:/work" }), {
      workspaceId: "ws-a",
      cwd: "C:/work",
    });
    assert.deepEqual(parseMemoryScopeRef({ workspaceId: null, cwd: "C:/work" }), {
      workspaceId: null,
      cwd: "C:/work",
    });
    // workspaceId 缺席按「没有工作区」：renderer 写 ?? null 还是直接透传是同一件事
    assert.deepEqual(parseMemoryScopeRef({ cwd: "C:/work" }), { workspaceId: null, cwd: "C:/work" });
  });

  test("parseMemoryScopeRef 拒掉形状不对的请求", () => {
    for (const bad of [null, undefined, "ws-a", 42, [], {}, { cwd: 42 }, { cwd: null }, { workspaceId: 7, cwd: "C:/" }, { workspaceId: {}, cwd: "C:/" }]) {
      assert.throws(() => parseMemoryScopeRef(bad), /memory request/);
    }
  });

  test("parseMemoryRemoveRequest 带上校验过的 entryId", () => {
    assert.deepEqual(parseMemoryRemoveRequest({ workspaceId: "ws-a", cwd: "C:/work", entryId: "mem_1" }), {
      workspaceId: "ws-a",
      cwd: "C:/work",
      entryId: "mem_1",
    });
    // 空串在这里不收也不拒的镜像：它过得来，由 store 回答「什么都没删」（幂等）
    assert.equal(parseMemoryRemoveRequest({ workspaceId: null, cwd: "C:/work", entryId: "" }).entryId, "");
  });

  test("parseMemoryRemoveRequest 拒掉 entryId 不是字符串的请求", () => {
    for (const bad of [{ workspaceId: null, cwd: "C:/" }, { workspaceId: null, cwd: "C:/", entryId: 3 }, { workspaceId: null, cwd: "C:/", entryId: null }]) {
      assert.throws(() => parseMemoryRemoveRequest(bad), /memory request/);
    }
  });
});
