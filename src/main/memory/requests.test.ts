/**
 * 装配层的回归网：作用域由主进程按会话归属解析（workspaceId ?? cwd）、召回合并
 * 全局 + 常驻直通 + 注入账本、append 验冲突建议、管理面（库 / 轮汇总 / 入参校验）。
 * store 与 usage 用真的（临时目录），会话存储用 stub——这里测的是接线，不是落盘。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { MEMORY_GLOBAL_SCOPE } from "../../shared/memory.ts";
import {
  applyMemoryAppend,
  applyMemoryContext,
  applyMemoryRetrieve,
  listScopes,
  parseBatchTarget,
  parseExcerptRequest,
  parsePatchRequest,
  parseResolveRequest,
  parseScopeToken,
  sessionTurns,
  type SessionScopeReader,
} from "./requests.ts";
import { MemoryStore } from "./store.ts";
import { MemoryUsageStore } from "./usage.ts";

/** 时间戳要贴近「现在」：衰减半衰期 180 天，用 epoch 0 之类的老时间戳会被衰减判负。 */
const NOW = Date.now();

let dir = "";
let memory: MemoryStore;
let usage: MemoryUsageStore;
let wsAToken = "";
let globalToken = "";

/** 会话归属的 stub：两条会话，一条在工作区里，一条只有 cwd，还有一条查无此会话。 */
class FakeSessions implements SessionScopeReader {
  readonly asked: string[] = [];

  async readMeta(
    id: string,
  ): Promise<{ workspaceId: string | null; cwd: string; title?: string } | null> {
    this.asked.push(id);
    if (id === "in-workspace") return { workspaceId: "ws-a", cwd: "C:/elsewhere", title: "工作区会话" };
    if (id === "no-workspace") return { workspaceId: null, cwd: "C:/work/project" };
    return null;
  }
}

const retrieve = (
  sessionId: string,
  query: string,
  turn = 1,
): Extract<AgentEvent, { type: "memoryRetrieveRequest" }> => ({
  type: "memoryRetrieveRequest",
  requestId: "r1",
  sessionId,
  query,
  turn,
});

const append = (
  sessionId: string,
  turn: number,
  entries: { text: string; keywords: string[]; timestamp: number; supersedes?: string }[],
): Extract<AgentEvent, { type: "memoryAppend" }> => ({ type: "memoryAppend", sessionId, turn, entries });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-memory-ipc-"));
  memory = new MemoryStore(dir);
  usage = new MemoryUsageStore(dir);
  wsAToken = memory.tokenOf("ws-a");
  globalToken = memory.tokenOf(MEMORY_GLOBAL_SCOPE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyMemoryAppend", () => {
  test("按会话归属落进对应作用域：工作区里的会话与只有 cwd 的会话不互通", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "用户偏好用 bun 作为包管理器", keywords: ["bun", "包管理器"], timestamp: NOW },
    ]));
    await applyMemoryAppend(sessions, memory, append("no-workspace", 1, [
      { text: "用户偏好用 bun 作为包管理器", keywords: ["bun", "包管理器"], timestamp: NOW - 60_000 },
    ]));
    await applyMemoryAppend(sessions, memory, append("gone", 1, [
      { text: "会话已删，无处可落", keywords: ["bun"], timestamp: NOW },
    ]));

    // ws-a 与 C:/work/project 各一份，互不看见；gone 那条静默丢弃（只记日志，不抛）
    assert.deepEqual(
      (await memory.list(wsAToken)).map((entry) => entry.sessionId),
      ["in-workspace"],
    );
    assert.deepEqual(
      (await memory.list(memory.tokenOf("C:/work/project"))).map((entry) => entry.sessionId),
      ["no-workspace"],
    );
  });

  test("0 条 draft 不碰盘", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, []));
    assert.deepEqual(await memory.list(wsAToken), []);
  });

  test("冲突建议先验再落：目标不在（幻觉 id / 已删）不落标，条目本体照常落", async () => {
    const sessions = new FakeSessions();
    const [old] = await memory.append(wsAToken, "s0", 1, [
      { text: "旧决定", keywords: ["旧"], timestamp: NOW },
    ]);
    assert.ok(old !== undefined);
    await applyMemoryAppend(sessions, memory, append("in-workspace", 2, [
      { text: "新决定", keywords: ["新"], timestamp: NOW, supersedes: old.id },
      { text: "带幻觉建议的", keywords: ["幻觉"], timestamp: NOW, supersedes: "mem_不存在" },
    ]));
    const entries = await memory.list(wsAToken);
    assert.equal(entries.find((entry) => entry.text === "新决定")?.supersedes, old.id);
    assert.equal(entries.find((entry) => entry.text === "带幻觉建议的")?.supersedes, undefined);
  });
});

describe("applyMemoryRetrieve（合并全局 + 常驻直通 + 注入账本）", () => {
  test("召回的是这条会话所在作用域 + 全局的记忆", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "用户偏好用 bun 作为包管理器，禁用 npm", keywords: ["bun", "包管理器"], timestamp: NOW },
    ]));
    // 全局条目：别的会话移过去的，跨工作区召回要带得上
    await memory.addManual(globalToken, "用户的时区是新加坡");
    const mine = await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "包管理器用什么"));
    assert.equal(mine.ok, true);
    if (!mine.ok) return;
    // 常驻在前（手动添加的默认常驻）、词法命中在后
    assert.deepEqual(
      mine.hits.map((hit) => hit.entry.text),
      ["用户的时区是新加坡", "用户偏好用 bun 作为包管理器，禁用 npm"],
    );
  });

  test("常驻摘抄不打分也注入（query 与它毫无词汇交集），并标 pinned", async () => {
    const sessions = new FakeSessions();
    await memory.addExcerpt(wsAToken, "in-workspace", {
      verbatim: "先调研再动手，结论用自然语言汇报。",
      role: "user",
      turn: 1,
      stance: "position",
    });
    const outcome = await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "端口号是多少"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.hits.length, 1);
    assert.equal(outcome.hits[0]?.pinned, true);
    assert.equal(outcome.hits[0]?.score, 1);
    assert.equal(outcome.hits[0]?.entry.text, "先调研再动手，结论用自然语言汇报。");
  });

  test("superseded / muted 不再参与召回（含常驻的 muted）", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "被替代的旧决定", keywords: ["决定"], timestamp: NOW },
      { text: "活着的新决定", keywords: ["决定"], timestamp: NOW },
    ]));
    const entries = await memory.list(wsAToken);
    const old = entries[0];
    assert.ok(old !== undefined);
    await memory.patch(wsAToken, old.id, { status: "superseded" });
    const excerpt = await memory.addExcerpt(wsAToken, "in-workspace", {
      verbatim: "被静音的摘抄",
      role: "assistant",
      turn: 1,
      stance: "agree",
    });
    await memory.patch(wsAToken, excerpt.id, { status: "muted" });

    const outcome = await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "决定是什么"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(
      outcome.hits.map((hit) => hit.entry.text),
      ["活着的新决定"],
    );
  });

  test("每一轮都落一条注入账本（含零命中）——按轮汇总的地基", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "dev 端口固定 5273", keywords: ["端口"], timestamp: NOW },
    ]));
    await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "端口是多少", 1));
    await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "完全无关的问题", 2));
    const records = await usage.bySession("in-workspace");
    assert.equal(records.length, 2);
    assert.equal(records[0]?.turn, 1);
    assert.equal(records[0]?.hits.length, 1);
    assert.equal(records[1]?.turn, 2);
    assert.deepEqual(records[1]?.hits, []);
  });

  test("读不到会话 meta = 没有可注入的（ok: true 配空 hits），不抛；账本照落", async () => {
    const sessions = new FakeSessions();
    const outcome = await applyMemoryRetrieve(sessions, memory, usage, retrieve("gone", "包管理器"));
    assert.deepEqual(outcome, { ok: true, hits: [] });
    assert.equal((await usage.bySession("gone")).length, 1);
  });

  test("空库 / 无命中都是 ok: true 配空 hits", async () => {
    const sessions = new FakeSessions();
    assert.deepEqual(await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "包管理器")), {
      ok: true,
      hits: [],
    });
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "用户喜欢深色主题", keywords: ["主题"], timestamp: NOW },
    ]));
    assert.deepEqual(await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "端口号是多少")), {
      ok: true,
      hits: [],
    });
  });
});

describe("event.scope 优先（首轮竞态回归：meta 未落盘也要能召回）", () => {
  test("带 scope 的请求不读 meta，首轮即可召回", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "用户养了一只叫「雪球」的橘猫", keywords: ["雪球", "猫"], timestamp: NOW },
    ]));
    // "gone" 查无此会话（meta 还没落盘的首轮）；但请求带了开轮命令里的 scope
    const outcome = await applyMemoryRetrieve(sessions, memory, usage, {
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
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "项目 dev 端口固定 5273", keywords: ["端口"], timestamp: NOW },
    ]));
    const outcome = await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "端口是多少"));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.hits.length, 1);
    // append 一次 + 退回 meta 的召回一次
    assert.deepEqual(sessions.asked, ["in-workspace", "in-workspace"]);
  });
});

describe("listScopes（作用域清单）", () => {
  test("工作区 / Home / 全局三分，删空的作用域不列", async () => {
    await memory.append(wsAToken, "s1", 1, [{ text: "A", keywords: [], timestamp: NOW }]);
    await memory.append(globalToken, "s1", 1, [{ text: "G", keywords: [], timestamp: NOW }]);
    const homeToken = memory.tokenOf("C:/home-only");
    await memory.append(homeToken, "s1", 1, [{ text: "H", keywords: [], timestamp: NOW }]);
    const scopes = await listScopes(memory, {
      list: async () => [{ id: "ws-a", name: "orbita 仓库" }],
    });
    assert.deepEqual(
      scopes.map((scope) => ({ kind: scope.kind, name: scope.name, count: scope.count })),
      [
        { kind: "workspace", name: "orbita 仓库", count: 1 },
        { kind: "home", name: "Home", count: 1 },
        { kind: "global", name: "global", count: 1 },
      ],
    );
    // token 就是文件名：renderer 拿它回来寻址，能找回同一个作用域
    assert.equal(scopes[0]?.token, wsAToken);
    assert.equal(scopes[2]?.token, globalToken);
  });

  test("多个 Home 作用域时名字带短 token 区分", async () => {
    await memory.append(memory.tokenOf("C:/one"), "s", 1, [{ text: "1", keywords: [], timestamp: NOW }]);
    await memory.append(memory.tokenOf("C:/two"), "s", 1, [{ text: "2", keywords: [], timestamp: NOW }]);
    const scopes = await listScopes(memory, { list: async () => [] });
    const homes = scopes.filter((scope) => scope.kind === "home");
    assert.equal(homes.length, 2);
    assert.notEqual(homes[0]?.name, homes[1]?.name);
  });
});

describe("sessionTurns（审查面板 › 记忆页签的数据）", () => {
  test("按轮倒序：注入（含零命中轮）与新增并成一份账，冲突建议配上旧条目", async () => {
    const sessions = new FakeSessions();
    const [old] = await memory.append(wsAToken, "别的会话", 5, [
      { text: "旧的包管理器决定", keywords: ["决定"], timestamp: NOW - 1000 },
    ]);
    assert.ok(old !== undefined);
    await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "无关", 1)); // 零命中轮
    await applyMemoryAppend(sessions, memory, append("in-workspace", 2, [
      { text: "新的包管理器决定", keywords: ["决定"], timestamp: NOW, supersedes: old.id },
    ]));
    await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "决定是什么", 3));

    const summary = await sessionTurns(sessions, memory, usage, "in-workspace");
    assert.deepEqual(
      summary.turns.map((turn) => turn.turn),
      [3, 2, 1],
    );
    // 第 3 轮：注入了新旧两条（都过得了「决定」的词法闸）
    const turn3 = summary.turns[0];
    assert.ok(turn3 !== undefined);
    assert.equal(turn3.injected.length, 2);
    assert.equal(turn3.added.length, 0);
    // 第 2 轮：新增一条，带待处理的冲突建议
    const turn2 = summary.turns[1];
    assert.ok(turn2 !== undefined);
    assert.equal(turn2.added.length, 1);
    assert.equal(turn2.added[0]?.conflictWith?.id, old.id);
    // 第 1 轮：什么都没有——账本上仍然有这一轮
    const turn1 = summary.turns[2];
    assert.ok(turn1 !== undefined);
    assert.equal(turn1.injected.length, 0);
    assert.equal(turn1.added.length, 0);
    // 待处理冲突 = 1（拍板前）
    assert.equal(summary.pendingConflicts, 1);
  });

  test("拍板后 pendingConflicts 归零，冲突卡不再配对（conflictWith = null）", async () => {
    const sessions = new FakeSessions();
    const [old] = await memory.append(wsAToken, "s0", 1, [{ text: "旧", keywords: [], timestamp: NOW }]);
    assert.ok(old !== undefined);
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "新", keywords: [], timestamp: NOW, supersedes: old.id },
    ]));
    await memory.resolveConflict(wsAToken, globalToken, { newId: (await memory.list(wsAToken))[1]?.id ?? "", oldId: old.id }, "replace", false);
    const summary = await sessionTurns(sessions, memory, usage, "in-workspace");
    assert.equal(summary.pendingConflicts, 0);
    assert.equal(summary.turns[0]?.added[0]?.conflictWith, null);
  });

  test("meta 读不到 = 空汇总（会话已删），不抛", async () => {
    const summary = await sessionTurns(new FakeSessions(), memory, usage, "gone");
    assert.deepEqual(summary, { turns: [], pendingConflicts: 0, scopeToken: "" });
  });

  test("注入账本里的条目已删时，那一项从展示里退场", async () => {
    const sessions = new FakeSessions();
    const [kept, dropped] = await memory.append(wsAToken, "s0", 1, [
      { text: "留下的一条", keywords: ["条"], timestamp: NOW },
      { text: "会删掉的一条", keywords: ["条"], timestamp: NOW },
    ]);
    assert.ok(kept !== undefined && dropped !== undefined);
    await applyMemoryRetrieve(sessions, memory, usage, retrieve("in-workspace", "条", 1));
    await memory.remove(wsAToken, dropped.id);
    const summary = await sessionTurns(sessions, memory, usage, "in-workspace");
    assert.deepEqual(
      summary.turns[0]?.injected.map((item) => item.id),
      [kept.id],
    );
  });
});

describe("管理面入参校验（renderer 那头什么都能传）", () => {
  test("parseScopeToken 只认 40 位小写 hex，别的当场抛", () => {
    const token = "a".repeat(40);
    assert.equal(parseScopeToken(token), token);
    // sha1 的 hex 输出恒小写；大写不是我们造得出的 token，拒
    for (const bad of [null, undefined, 42, "", "abc", `${token}x`, token.toUpperCase()]) {
      assert.throws(() => parseScopeToken(bad), /memory request/);
    }
  });

  test("parseBatchTarget 校验 token 与 id 数组", () => {
    const token = "b".repeat(40);
    assert.deepEqual(parseBatchTarget({ token, entryIds: ["mem_1", "mem_2"] }), {
      token,
      entryIds: ["mem_1", "mem_2"],
    });
    assert.throws(() => parseBatchTarget({ token, entryIds: "mem_1" }), /memory request/);
    assert.throws(() => parseBatchTarget({ token, entryIds: [1] }), /memory request/);
  });

  test("parsePatchRequest 逐字段可选，类型不对当场抛", () => {
    const token = "c".repeat(40);
    assert.deepEqual(parsePatchRequest({ token, entryId: "mem_1", text: "新正文" }), {
      token,
      entryId: "mem_1",
      text: "新正文",
    });
    assert.deepEqual(parsePatchRequest({ token, entryId: "mem_1", pinned: false }), {
      token,
      entryId: "mem_1",
      pinned: false,
    });
    assert.deepEqual(parsePatchRequest({ token, entryId: "mem_1", status: "muted" }), {
      token,
      entryId: "mem_1",
      status: "muted",
    });
    for (const bad of [
      { token, entryId: "mem_1", text: 3 },
      { token, entryId: "mem_1", pinned: "yes" },
      { token, entryId: "mem_1", status: "好" },
      { token, entryId: "", text: "x" },
    ]) {
      assert.throws(() => parsePatchRequest(bad), /memory/);
    }
  });

  test("parseResolveRequest 校验三个枚举与 undo 布尔", () => {
    const token = "d".repeat(40);
    assert.deepEqual(
      parseResolveRequest({ token, newId: "mem_n", oldId: "mem_o", resolution: "keep-both", undo: true }),
      { token, newId: "mem_n", oldId: "mem_o", resolution: "keep-both", undo: true },
    );
    assert.equal(parseResolveRequest({ token, newId: "mem_n", oldId: "mem_o", resolution: "replace" }).undo, false);
    for (const bad of [
      { token, newId: "mem_n", oldId: "mem_o", resolution: "替换" },
      { token, newId: "", oldId: "mem_o", resolution: "replace" },
      { token, newId: "mem_n", oldId: "mem_o", resolution: "replace", undo: 1 },
    ]) {
      assert.throws(() => parseResolveRequest(bad), /memory/);
    }
  });

  test("parseExcerptRequest 校验轮号 / 角色 / 态度与原文", () => {
    const good = {
      sessionId: "s1",
      verbatim: "一句话",
      role: "assistant",
      turn: 3,
      stance: "doubt",
    };
    assert.deepEqual(parseExcerptRequest(good), good);
    for (const bad of [
      { ...good, verbatim: "  " },
      { ...good, role: "system" },
      { ...good, turn: 0 },
      { ...good, turn: 1.5 },
      { ...good, stance: "喜欢" },
      { ...good, sessionId: "" },
    ]) {
      assert.throws(() => parseExcerptRequest(bad), /memory/);
    }
  });
});

describe("applyMemoryContext（蒸馏的冲突候选）", () => {
  test("按这轮内容挑最像的活条目（本作用域 + 全局），superseded / muted 不进候选", async () => {
    const sessions = new FakeSessions();
    await applyMemoryAppend(sessions, memory, append("in-workspace", 1, [
      { text: "用户决定包管理器用 bun，bun 是唯一 lock writer", keywords: ["bun", "包管理器"], timestamp: NOW },
      { text: "无关的旧记忆：用户养了一只猫", keywords: ["猫"], timestamp: NOW },
    ]));
    await memory.addManual(globalToken, "构建走 bun install");
    const entries = await memory.list(wsAToken);
    await memory.patch(wsAToken, entries[1]?.id ?? "", { status: "muted" });

    const outcome = await applyMemoryContext(sessions, memory, {
      type: "memoryContextRequest",
      requestId: "r9",
      sessionId: "in-workspace",
      query: "包管理器还是换回 npm 吧，bun 在 Windows 上老出问题，构建也改成 npm install",
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(
      outcome.candidates.map((candidate) => candidate.text),
      ["用户决定包管理器用 bun，bun 是唯一 lock writer", "构建走 bun install"],
    );
  });

  test("meta 读不到 = 空候选（ok: true），不抛", async () => {
    const outcome = await applyMemoryContext(new FakeSessions(), memory, {
      type: "memoryContextRequest",
      requestId: "r10",
      sessionId: "gone",
      query: "任意内容",
    });
    assert.deepEqual(outcome, { ok: true, candidates: [] });
  });
});
