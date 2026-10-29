/**
 * 记忆库读面装配（library.ts）——作用域命名、条目装配（标题 / 原话片段 /
 * 演变链）、按轮视图、待确认清单。纯模块直测（node --test）：临时目录放
 * 条目 / 事件段 / 注入账本，会话与工作区注入桩。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLibrary } from "./library.ts";
import { MemoryEntryStore, tokenOfScope } from "../../memory/entries.ts";
import { EpisodeStore } from "../../memory/episodes.ts";

const WS_TOKEN = tokenOfScope("ws-1");
const WS2_TOKEN = tokenOfScope("ws-2");
const HOME_TOKEN = tokenOfScope("/Users/某家/Home");

/** 会话标题桩：s1 → 已知标题，s2 → null（已删）。 */
function makeLibrary(
  dir: string,
  overrides: {
    titles?: Record<string, string | null>;
    workspaces?: { id: string; name: string }[];
    metas?: Record<string, { workspaceId: string | null; cwd: string }>;
  } = {},
): MemoryLibrary {
  return new MemoryLibrary(dir, {
    sessionTitleOf: async (id) => overrides.titles?.[id] ?? null,
    workspaces: async () => overrides.workspaces ?? [{ id: "ws-1", name: "orbita" }],
    readMeta: async (id) =>
      overrides.metas?.[id] ?? { workspaceId: "ws-1", cwd: "/Users/某家/Orbita/orbita" },
  });
}

const EPISODE = {
  episodeId: "ep_1",
  sessionId: "s1",
  scopeId: "ws-1",
  fromTurn: 1,
  toTurn: 2,
  openedAt: 1,
  lastAt: 2,
  turns: [
    { turn: 1, at: 1000, userText: "先合并当前四个".padEnd(400, "。"), assistantText: "好的" },
    { turn: 2, at: 2000, userText: "还是一次合一个吧", assistantText: "明白" },
  ],
};

async function seed(dir: string): Promise<void> {
  const entries = new MemoryEntryStore(dir);
  const episodes = new EpisodeStore(dir);
  // 归档事件段（原话片段从这取）
  await mkdir(join(dir, "episodes"), { recursive: true });
  await writeFile(join(dir, "episodes", "log.jsonl"), `${JSON.stringify(EPISODE)}\n`, "utf8");
  // 旧偏好（将被新偏好指矛盾）
  await entries.appendScope("ws-1", EPISODE, [
    { type: "preference", text: "记忆库放在设置里", reason: "r", keywords: [], turns: [1] },
  ]);
  // 新偏好 + 指向旧的冲突建议（未拍板）+ 待升层
  await entries.appendScope("ws-1", EPISODE, [
    { type: "preference", text: "在 Orbita 内做记忆库页", reason: "r", keywords: [], turns: [2], pendingPromote: true },
  ]);
  const wsEntries = await entries.listByToken(WS_TOKEN);
  const oldId = wsEntries[0]!.id;
  await entries.updateEntry(WS_TOKEN, wsEntries[1]!.id, (current) => ({
    ...current,
    conflictWith: oldId,
    pendingPromote: true,
  }));
  // user 层一条常驻偏好
  await entries.addManual("user", { type: "preference", text: "本地优先", reason: "r", now: 3000 });
  // 注入账本：第 1 轮零命中，第 2 轮命中 user 层那条
  const userId = (await entries.listByToken("user"))[0]!.id;
  await entries.recordInjection({ sessionId: "s1", turn: 1, at: 1000, hits: [] });
  await entries.recordInjection({
    sessionId: "s1",
    turn: 2,
    at: 2000,
    hits: [{ id: userId, text: "本地优先", score: 1, pinned: true }],
  });
  // 另一个工作区层 + 一个 Home 层（作用域命名用）
  await entries.appendScope("ws-2", EPISODE, [
    { type: "fact", text: "ws-2 的事实", keywords: [], turns: [1] },
  ]);
}

test("scopes：user 恒在；对得上工作区表的带名字；对不上是 Home（多个带短后缀）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-lib-"));
  await seed(dir);
  const library = makeLibrary(dir, {
    workspaces: [
      { id: "ws-1", name: "orbita" },
      { id: "ws-2", name: "memory-bench" },
    ],
  });
  const scopes = await library.scopes();
  assert.deepEqual(
    scopes.map((scope) => `${scope.kind}:${scope.name}:${scope.count}`),
    ["user:所有工作区:1", "workspace:memory-bench:1", "workspace:orbita:2"],
  );
  // seed 没写 Home 条目：空层不列（只有装着条目的文件算一层）
  assert.equal(scopes.find((scope) => scope.kind === "home"), undefined);
});

test("scopes：多个 Home 带短 token 后缀区分", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-lib-"));
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("/Users/a/Home", EPISODE, [
    { type: "fact", text: "a 家的事实", keywords: [], turns: [1] },
  ]);
  await entries.appendScope("/Users/b/Home", EPISODE, [
    { type: "fact", text: "b 家的事实", keywords: [], turns: [1] },
  ]);
  const library = makeLibrary(dir, { workspaces: [] });
  const scopes = await library.scopes();
  const homes = scopes.filter((scope) => scope.kind === "home");
  assert.equal(homes.length, 2);
  assert.ok(homes.every((home) => /^Home [0-9a-f]{6}$/.test(home.name)));
});

test("listEntries：标题 / 原话片段（最新支撑轮、截 300）/ 类型与作用域筛选", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-lib-"));
  await seed(dir);
  const library = makeLibrary(dir, { titles: { s1: "审核PR验收顺序" } });
  const items = await library.listEntries({ token: WS_TOKEN });
  assert.equal(items.length, 2);
  const newer = items.find((item) => item.entry.turns.includes(2))!;
  assert.equal(newer.sessionTitle, "审核PR验收顺序");
  assert.equal(newer.token, WS_TOKEN);
  // 原话片段取最新支撑轮（turn 2），截到 300
  assert.equal(newer.quote, "还是一次合一个吧");
  const older = items.find((item) => item.entry.turns.includes(1))!;
  assert.equal(older.quote?.length, 300);
  // 筛选
  const prefs = await library.listEntries({ token: WS_TOKEN, type: "preference" });
  assert.equal(prefs.length, 2);
  const all = await library.listEntries({ token: "all" });
  assert.equal(all.length, 4); // ws-1 两条 + user 一条 + ws-2 一条
  const userOnly = await library.listEntries({ token: "user" });
  assert.equal(userOnly.length, 1);
});

test("listEntries：演变链沿 conflictWith 串新旧（含自身，旧→新），无关联为空", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-lib-"));
  await seed(dir);
  const library = makeLibrary(dir);
  const items = await library.listEntries({ token: WS_TOKEN });
  const newer = items.find((item) => item.entry.conflictWith !== undefined)!;
  const older = items.find((item) => item.entry.conflictWith === undefined && item.entry.type === "preference")!;
  // 两条都在链上看到对方（旧的被指、新的指人），顺序旧 → 新
  assert.deepEqual(newer.evolution.map((node) => node.text), ["记忆库放在设置里", "在 Orbita 内做记忆库页"]);
  assert.equal(older.evolution.length, 2);
  // user 层那条没有关联
  const lone = (await library.listEntries({ token: "user" }))[0]!;
  assert.deepEqual(lone.evolution, []);
});

test("sessionView：轮集合 = 账本 ∪ 新增；用到带快照；organizing；pendingCount", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-lib-"));
  await seed(dir);
  const library = makeLibrary(dir, { metas: { s1: { workspaceId: "ws-1", cwd: "/x" } } });
  const view = await library.sessionView("s1");
  assert.equal(view.token, WS_TOKEN);
  assert.equal(view.turns.length, 2); // 轮 1（零命中账本）+ 轮 2（账本 + 新增）
  assert.deepEqual(view.turns[0]?.used.map((hit) => [hit.text, hit.pinned]), [["本地优先", true]]);
  assert.deepEqual(view.turns[1]?.used, []);
  assert.equal(view.turns[0]?.remembered.length, 1); // 第 2 轮支撑的新条目
  assert.equal(view.organizing, false);
  // 待确认：本作用域一条升层 ask + 一条冲突 ask（user 层没有）
  assert.equal(view.pendingCount, 2);

  // 开段在盘上 → organizing
  const episodes = new EpisodeStore(dir);
  await episodes.saveOpen({
    episodeId: "ep_open",
    sessionId: "s1",
    scopeId: "ws-1",
    fromTurn: 3,
    toTurn: 3,
    openedAt: 1,
    lastAt: 1,
    turns: [{ turn: 3, at: 1, userText: "u", assistantText: "a" }],
    extracted: { fact: false, preference: false, insight: false },
  });
  const view2 = await library.sessionView("s1");
  assert.equal(view2.organizing, true);
});

test("pending：升层与冲突的 ask 都在；旧条已删的冲突不再 ask；拍板过的带 resolution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-lib-"));
  await seed(dir);
  const entries = new MemoryEntryStore(dir);
  const library = makeLibrary(dir);
  let items = await library.pending();
  assert.equal(items.length, 2); // 一条 promote ask + 一条 conflict ask
  const conflict = items.find((item) => item.kind === "conflict")!;
  assert.notEqual(conflict.old, null);
  assert.equal(conflict.resolution, undefined);
  const promote = items.find((item) => item.kind === "promote")!;
  assert.equal(promote.entry.pendingPromote, true);

  // 拍板后：带 resolution（撤销键的来处）
  await entries.updateEntry(WS_TOKEN, conflict.entry.id, (current) => ({
    ...current,
    conflictResolution: "stale-old",
  }));
  items = await library.pending();
  assert.equal(items.find((item) => item.kind === "conflict")?.resolution, "stale-old");

  // 旧条删掉 + 未拍板的新条：不再 ask（没什么可拍）
  await entries.updateEntry(WS_TOKEN, conflict.entry.id, (current) => ({
    ...current,
    conflictResolution: undefined,
  }));
  await entries.removeEntry(WS_TOKEN, conflict.old!.id);
  items = await library.pending();
  assert.equal(items.filter((item) => item.kind === "conflict").length, 0);
});

test("sessionView：meta 读不到 → token null 但视图照常（零轮）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-lib-"));
  const library = makeLibrary(dir, { metas: {} });
  const readMeta = async () => null;
  const lib = new MemoryLibrary(dir, {
    sessionTitleOf: async () => null,
    workspaces: async () => [],
    readMeta,
  });
  const view = await lib.sessionView("s-unknown");
  assert.equal(view.token, null);
  assert.deepEqual(view.turns, []);
});
