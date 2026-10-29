/**
 * 记忆条目存储（entries.ts）——层文件、行解析、追加去重与出处盖章。
 * 纯模块直测（node --test）：临时目录当 userData。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromRevertedTurns, MemoryEntryStore, parseMemoryEntry, tokenOfScope } from "./entries.ts";
import { MEMORY_MUTED_REVERTED, type MemoryEntry, type MemoryEpisode } from "../shared/memory.ts";

function entry(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "mem_1",
    type: "fact",
    text: "用户的项目用 bun 管依赖",
    keywords: ["bun"],
    layer: "workspace",
    scopeId: "ws-1",
    sessionId: "s1",
    turns: [2],
    at: 1000,
    episodeId: "ep_1",
    source: "chat",
    ...overrides,
  };
}

function episode(): MemoryEpisode {
  return {
    episodeId: "ep_1",
    sessionId: "s1",
    scopeId: "ws-1",
    fromTurn: 1,
    toTurn: 3,
    openedAt: 900,
    lastAt: 3000,
    turns: [
      { turn: 1, at: 1000, userText: "u1", assistantText: "a1" },
      { turn: 2, at: 2000, userText: "u2", assistantText: "a2" },
      { turn: 3, at: 3000, userText: "u3", assistantText: "a3" },
    ],
  };
}

test("parseMemoryEntry：合法行全收，可选字段缺席按默认", () => {
  const parsed = parseMemoryEntry(entry());
  assert.notEqual(parsed, null);
  assert.equal(parsed?.status, undefined);
  assert.equal(parsed?.reason, undefined);
});

test("parseMemoryEntry：必填字段不齐（#228 旧格式缺 type/layer）返回 null", () => {
  assert.equal(parseMemoryEntry({ id: "mem_1", text: "旧格式的行", keywords: [], sessionId: "s1", timestamp: 1 }), null);
  assert.equal(parseMemoryEntry(entry({ layer: "workspace", scopeId: undefined })), null); // workspace 层缺 scopeId
  assert.equal(parseMemoryEntry(entry({ turns: [] })), null); // 出处轮号是承诺
  assert.equal(parseMemoryEntry(entry({ type: "mood" })), null);
  assert.equal(parseMemoryEntry("不是对象"), null);
});

test("parseMemoryEntry：轮号去重排序、可选枚举不认识的当缺席", () => {
  const parsed = parseMemoryEntry(entry({ turns: [3, 1, 3], status: "archived" }));
  assert.deepEqual(parsed?.turns, [1, 3]);
  assert.equal(parsed?.status, undefined);
});

test("appendScope：盖章 id/出处/episodeId，轮号夹回段内，时间位置取最新支撑轮", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const written = await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "事实一", keywords: ["k"], turns: [2, 99] },
    { type: "preference", text: "偏好一", reason: "因为", keywords: [], turns: [1, 3] },
  ]);
  assert.equal(written.length, 2);
  assert.equal(written[0]?.turns.length, 1); // 99 是段外轮号，夹掉了
  assert.equal(written[0]?.at, 2000);
  assert.equal(written[1]?.at, 3000);
  // 再读回来：行完整、按层落对文件（sha1(ws-1).jsonl）
  const listed = await store.listScope("ws-1");
  assert.equal(listed.length, 2);
  const names = await readdir(dir);
  assert.equal(names.length, 1);
  assert.notEqual(names[0], "user.jsonl");
});

test("appendScope：归一化文本去重（同作用域与 user 层都查）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "用户 用 bun", keywords: [], turns: [1] },
  ]);
  // 空白差异算逐字重复
  const again = await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "用户  用\n bun ", keywords: [], turns: [1] },
  ]);
  assert.equal(again.length, 0);
  // user 层已有的也不重复落进工作区层
  await writeFile(
    join(dir, "user.jsonl"),
    `${JSON.stringify(entry({ id: "mem_u", text: "用户用 bun", layer: "user", scopeId: undefined }))}\n`,
    "utf8",
  );
  const third = await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "用户用 bun", keywords: [], turns: [1] },
  ]);
  assert.equal(third.length, 0);
});

test("appendScope：偏好 / 经验没有 reason 的 draft 不落（契约承诺），事实允许", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const written = await store.appendScope("ws-1", episode(), [
    { type: "preference", text: "没理由的偏好", keywords: [], turns: [1] },
    { type: "insight", text: "没依据的经验", keywords: [], turns: [1] },
  ]);
  assert.equal(written.length, 0);
});

test("listUser / listScope：文件不存在 = 空，坏行跳过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  assert.deepEqual(await store.listUser(), []);
  assert.deepEqual(await store.listScope("ws-x"), []);
  const token = store.tokenOf("ws-1");
  await writeFile(join(dir, `${token}.jsonl`), "半截行\n" + `${JSON.stringify(entry())}\n` + "{又一行坏的\n", "utf8");
  const listed = await store.listScope("ws-1");
  assert.equal(listed.length, 1);
});

test("recordInjection：每轮一行（含零命中），只追加", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  await store.recordInjection({ sessionId: "s1", turn: 1, at: 1, hits: [] });
  await store.recordInjection({
    sessionId: "s1",
    turn: 2,
    at: 2,
    hits: [{ id: "mem_1", score: 0.5, pinned: true }],
  });
  const raw = await readFile(join(dir, "injections.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!).hits, []);
});

test("parseMemoryEntry：manual 条目没有出处三件套也合法；旧数据缺 source 严校", () => {
  const manual = parseMemoryEntry(
    entry({ id: "mem_m", source: "manual", sessionId: "", turns: [], episodeId: "", scopeId: undefined }),
  );
  assert.notEqual(manual, null);
  assert.equal(manual?.source, "manual");
  // 缺 source 的旧行按 chat 解读：出处三件套必须齐
  assert.equal(
    parseMemoryEntry(entry({ id: "mem_old", source: undefined, sessionId: "", turns: [] })),
    null,
  );
  // stale / promotedFrom / mutedReason / editedAt 都能读回；旧拍板字段不再解析
  const decided = parseMemoryEntry(
    entry({
      id: "mem_d",
      status: "stale",
      conflictResolution: "stale-old",
      promoteResolution: "user",
      pendingPromote: true,
      promotedFrom: "abc",
      mutedReason: "用户说不对",
      editedAt: 123,
    }),
  );
  assert.equal(decided?.status, "stale");
  assert.equal(decided?.promotedFrom, "abc");
  assert.equal(decided?.mutedReason, "用户说不对");
  assert.equal(decided?.editedAt, 123);
  assert.equal("conflictResolution" in (decided ?? {}), false);
  assert.equal("pendingPromote" in (decided ?? {}), false);
});

test("parseMemoryEntry：agent 修订的条目要有出处会话与轮号，事件段可空", () => {
  const revised = parseMemoryEntry(entry({ id: "mem_a", source: "agent", episodeId: "", turns: [4] }));
  assert.equal(revised?.source, "agent");
  assert.equal(parseMemoryEntry(entry({ id: "mem_a", source: "agent", sessionId: "", episodeId: "" })), null);
  assert.equal(parseMemoryEntry(entry({ id: "mem_a", source: "agent", turns: [], episodeId: "" })), null);
});

test("appendScope：跨工作区偏好直接落 user 层（promotedFrom 记原 token），不进工作区层", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const written = await store.appendScope("ws-1", episode(), [
    { type: "preference", text: "回复用中文", reason: "用户说的", keywords: [], turns: [1], crossWorkspace: true },
    { type: "preference", text: "这个项目用 bun", reason: "用户说的", keywords: [], turns: [1] },
    // crossWorkspace 只对偏好生效
    { type: "fact", text: "事实不升层", keywords: [], turns: [1], crossWorkspace: true },
  ]);
  assert.equal(written.length, 3);
  const user = await store.listUser();
  assert.deepEqual(user.map((item) => item.text), ["回复用中文"]);
  assert.equal(user[0]?.layer, "user");
  assert.equal(user[0]?.promotedFrom, store.tokenOf("ws-1"));
  assert.equal(user[0]?.scopeId, "ws-1"); // 撤销搬回时要它
  assert.deepEqual((await store.listScope("ws-1")).map((item) => item.text).sort(), ["事实不升层", "这个项目用 bun"].sort());
});

test("appendScope：conflictWith 指的旧条（本层或 user 层）直接标 stale；muted 的旧条不改判", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const [inScope, alreadyMuted] = await store.appendScope("ws-1", episode(), [
    { type: "preference", text: "汇报写成长段落", reason: "r", keywords: [], turns: [1] },
    { type: "preference", text: "被关掉的旧偏好", reason: "r", keywords: [], turns: [1] },
  ]);
  await store.updateEntry(store.tokenOf("ws-1"), alreadyMuted!.id, (item) => ({ ...item, status: "muted" }));
  const inUser = await store.addManual("user", { type: "preference", text: "user 层旧偏好", reason: "r", now: 1 });
  await store.appendScope("ws-1", episode(), [
    { type: "preference", text: "汇报改成三条要点", reason: "r", keywords: [], turns: [2], conflictWith: inScope!.id },
    { type: "preference", text: "user 层新说法", reason: "r", keywords: [], turns: [2], conflictWith: inUser!.id },
    { type: "preference", text: "顶掉 muted 的", reason: "r", keywords: [], turns: [2], conflictWith: alreadyMuted!.id },
  ]);
  const scope = await store.listScope("ws-1");
  assert.equal(scope.find((item) => item.id === inScope!.id)?.status, "stale");
  assert.equal(scope.find((item) => item.id === alreadyMuted!.id)?.status, "muted");
  assert.equal((await store.listUser()).find((item) => item.id === inUser!.id)?.status, "stale");
  const fresh = scope.find((item) => item.text === "汇报改成三条要点");
  assert.equal(fresh?.conflictWith, inScope!.id);
  assert.equal(fresh?.status, undefined);
});

test("appendRevision：新条同层、source agent、出处是会话那一轮、关键词沿用；旧条 stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const [old] = await store.appendScope("ws-1", episode(), [
    { type: "preference", text: "汇报写成长段落", reason: "r", keywords: ["汇报"], turns: [1] },
  ]);
  const token = store.tokenOf("ws-1");
  const pair = await store.appendRevision(token, old!.id, {
    text: "用户要求汇报写成三条要点",
    reason: "用户说「不对，汇报要三条要点」",
    sessionId: "s9",
    turn: 7,
    now: 5000,
  });
  assert.notEqual(pair, null);
  const [fresh, staled] = pair!;
  assert.equal(fresh.source, "agent");
  assert.equal(fresh.sessionId, "s9");
  assert.deepEqual(fresh.turns, [7]);
  assert.equal(fresh.at, 5000);
  assert.equal(fresh.episodeId, "");
  assert.equal(fresh.conflictWith, old!.id);
  assert.deepEqual(fresh.keywords, ["汇报"]);
  assert.equal(fresh.type, "preference");
  assert.equal(staled.status, "stale");
  // 读回：解析器认得 agent 行，两条都在
  const listed = await store.listByToken(token);
  assert.equal(listed.length, 2);
  assert.equal(listed.find((item) => item.id === old!.id)?.status, "stale");
  assert.equal(listed.find((item) => item.id === fresh.id)?.source, "agent");
  assert.equal(await store.appendRevision(token, "mem_不在", { text: "x", reason: "r", sessionId: "s", turn: 1, now: 1 }), null);
});

test("settleLegacyDecisions：旧的待确认按新规则落定一次；拍板过的照旧；只跑一次", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const token = store.tokenOf("ws-1");
  const rows = [
    entry({ id: "mem_promote", type: "preference", reason: "r", text: "回复用中文", pendingPromote: true }),
    entry({ id: "mem_kept", type: "preference", reason: "r", text: "只留本工作区的", pendingPromote: true, promoteResolution: "workspace" }),
    entry({ id: "mem_old", type: "preference", reason: "r", text: "旧说法" }),
    entry({ id: "mem_new", type: "preference", reason: "r", text: "新说法", conflictWith: "mem_old" }),
    entry({ id: "mem_old2", type: "preference", reason: "r", text: "两条都留的旧" }),
    entry({ id: "mem_new2", type: "preference", reason: "r", text: "两条都留的新", conflictWith: "mem_old2", conflictResolution: "keep-both" }),
  ];
  await writeFile(join(dir, `${token}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const settled = await store.settleLegacyDecisions();
  assert.deepEqual(settled, { promoted: 1, staled: 1 });
  const scope = await store.listByToken(token);
  const user = await store.listUser();
  assert.deepEqual(user.map((item) => item.id), ["mem_promote"]);
  assert.equal(user[0]?.promotedFrom, token);
  assert.equal(scope.find((item) => item.id === "mem_kept")?.layer, "workspace");
  assert.equal(scope.find((item) => item.id === "mem_old")?.status, "stale");
  assert.equal(scope.find((item) => item.id === "mem_old2")?.status, undefined); // keep-both 照旧
  // 用户随后「恢复旧说法」：再启动不能被重新顶回去
  await store.updateEntry(token, "mem_old", (item) => ({ ...item, status: "active" }));
  assert.deepEqual(await store.settleLegacyDecisions(), { promoted: 0, staled: 0 });
  assert.equal((await store.listByToken(token)).find((item) => item.id === "mem_old")?.status, "active");
});

test("settleLegacyDecisions：空库也落标记（之后新规则写的数据不再被扫）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  assert.deepEqual(await store.settleLegacyDecisions(), { promoted: 0, staled: 0 });
  assert.ok((await readdir(dir)).includes("legacy-decisions-settled.json"));
});

test("updateEntry / removeEntry：改一条与删一条（整层原子重写），不在幂等回 null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const token = store.tokenOf("ws-1");
  await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "条目一", keywords: [], turns: [1] },
    { type: "fact", text: "条目二", keywords: [], turns: [1] },
  ]);
  const first = (await store.listByToken(token))[0]!;
  const updated = await store.updateEntry(token, first.id, (current) => ({
    ...current,
    text: "改过的正文",
    editedAt: 42,
  }));
  assert.equal(updated?.text, "改过的正文");
  assert.equal(updated?.editedAt, 42);
  assert.equal((await store.listByToken(token)).length, 2); // 另一条还在
  const removed = await store.removeEntry(token, first.id);
  assert.equal(removed?.id, first.id);
  assert.equal((await store.listByToken(token)).length, 1);
  assert.equal(await store.removeEntry(token, "mem_不存在"), null);
  assert.equal(await store.updateEntry(token, "mem_不存在", (current) => current), null);
});

test("moveEntry：搬家不做去重（搬家不是新建，重复文本不该静默丢条）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const from = store.tokenOf("ws-1");
  await store.appendScope("ws-1", episode(), [
    { type: "preference", text: "要搬的偏好", reason: "r", keywords: [], turns: [1] },
  ]);
  // user 层先放一条同文本（若走去重搬家会丢）
  await store.addManual("user", { type: "fact", text: "要搬的偏好", now: 1 });
  const moved = await store.moveEntry(from, "user", (await store.listByToken(from))[0]!.id, (target) => ({
    ...target,
    layer: "user",
    scopeId: undefined,
    promotedFrom: from,
  }));
  assert.notEqual(moved, null);
  assert.equal(await store.listByToken(from).then((list) => list.length), 0);
  const userEntries = await store.listByToken("user");
  assert.equal(userEntries.length, 2); // 原有 + 搬来的，没被去重掉
});

test("moveEntry：先追加目标层再删源层，源层删除发生时目标已可读", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const from = store.tokenOf("ws-1");
  const seeded = await store.appendScope("ws-1", episode(), [
    { type: "fact", text: "不能因搬家中断而丢失", keywords: [], turns: [1] },
  ]);
  const id = seeded[0]!.id;
  const removeEntry = store.removeEntry.bind(store);
  let targetExistedBeforeSourceRemoval = false;
  store.removeEntry = async (token, entryId) => {
    targetExistedBeforeSourceRemoval = (await store.listByToken("user")).some((entry) => entry.id === id);
    return removeEntry(token, entryId);
  };
  await store.moveEntry(from, "user", id, (target) => ({ ...target, layer: "user", scopeId: undefined }));
  assert.equal(targetExistedBeforeSourceRemoval, true);
});

test("addManual：落指定层、盖 id/时间、偏好没 reason 拒收", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  const token = store.tokenOf("ws-1");
  const added = await store.addManual(token, {
    type: "preference",
    text: " 手动加的偏好 ",
    reason: " 用户亲口说的 ",
    scopeId: "ws-1",
    now: 100,
  });
  assert.notEqual(added, null);
  assert.equal(added?.text, "手动加的偏好");
  assert.equal(added?.reason, "用户亲口说的");
  assert.equal(added?.source, "manual");
  assert.equal(added?.sessionId, "");
  assert.deepEqual(added?.turns, []);
  const rejected = await store.addManual(token, { type: "preference", text: "没理由", now: 101 });
  assert.equal(rejected, null);
  const userFact = await store.addManual("user", { type: "fact", text: "user 层的事实", now: 102 });
  assert.equal(userFact?.layer, "user");
});

test("listLayers：只列装着条目的层，injections 不算层", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  assert.deepEqual(await store.listLayers(), []);
  await store.appendScope("ws-1", episode(), [{ type: "fact", text: "一", keywords: [], turns: [1] }]);
  await store.addManual("user", { type: "fact", text: "二", now: 1 });
  await store.recordInjection({ sessionId: "s", turn: 1, at: 1, hits: [] });
  const layers = await store.listLayers();
  assert.equal(layers.length, 2);
  assert.ok(layers.some((layer) => layer.token === "user" && layer.count === 1));
});

test("listInjections：读回含正文快照；坏行跳过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  const store = new MemoryEntryStore(dir);
  await store.recordInjection({
    sessionId: "s1",
    turn: 1,
    at: 1,
    hits: [{ id: "mem_1", text: "注入时的正文", score: 1, pinned: true }],
  });
  await appendFile(join(dir, "injections.jsonl"), "坏行\n", "utf8");
  const records = await store.listInjections();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.hits[0]?.text, "注入时的正文");
});

/* ---------- 会话回退：停用来源轮全被撤回的条目、恢复它们顶掉的旧条 ---------- */

async function seedLayers(dir: string, layers: Record<string, unknown[]>): Promise<void> {
  for (const [token, rows] of Object.entries(layers)) {
    await writeFile(join(dir, `${token}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  }
}

async function applyPlan(store: MemoryEntryStore, sessionId: string, fromTurn: number) {
  const plan = await store.planRevert(sessionId, fromTurn);
  let muted = 0;
  let restored = 0;
  for (const token of new Set([...plan.mute.keys(), ...plan.restore.keys()])) {
    const outcome = await store.applyRevert(token, {
      sessionId,
      fromTurn,
      mute: plan.mute.get(token) ?? new Set(),
      restore: plan.restore.get(token) ?? new Set(),
    });
    muted += outcome.muted;
    restored += outcome.restored;
  }
  return { plan, muted, restored };
}

function byIdOf(list: readonly MemoryEntry[]): Map<string, MemoryEntry> {
  return new Map(list.map((item) => [item.id, item]));
}

test("fromRevertedTurns：来源轮全部 ≥ 回退点才算；有一轮在前面就不算；别的会话不算", () => {
  const base = parseMemoryEntry(entry({ turns: [3, 4] }))!;
  assert.equal(fromRevertedTurns(base, "s1", 3), true);
  assert.equal(fromRevertedTurns({ ...base, turns: [2, 3] }, "s1", 3), false);
  assert.equal(fromRevertedTurns(base, "s2", 3), false);
  assert.equal(fromRevertedTurns({ ...base, turns: [] }, "s1", 1), false);
});

test("回退停用：全部来源轮被撤回的停用（含自动升层、agent 修订）；部分来源轮 / 手动 / 手改 / 别的会话 / 已停用的不动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-entries-"));
  const ws = tokenOfScope("ws-1");
  await seedLayers(dir, {
    [ws]: [
      entry({ id: "mem_full", turns: [3, 4], text: "全部来源轮都被撤回" }),
      entry({ id: "mem_partial", turns: [2, 3], text: "有一轮没被撤回" }),
      entry({ id: "mem_before", turns: [1], text: "回退点之前" }),
      entry({ id: "mem_manual", source: "manual", sessionId: "", turns: [], episodeId: "", text: "手动添加的" }),
      entry({ id: "mem_edited", turns: [4], editedAt: 9000, text: "用户手改过的" }),
      entry({ id: "mem_other", sessionId: "s2", turns: [5], text: "别的会话" }),
      entry({ id: "mem_retired", turns: [4], status: "muted", mutedReason: "agent 说不对", text: "已经停用的" }),
    ],
    user: [
      entry({ id: "mem_promoted", layer: "user", type: "preference", reason: "理由", promotedFrom: ws, turns: [5], text: "自动升层的" }),
      entry({ id: "mem_agent", layer: "user", source: "agent", episodeId: "", turns: [4], text: "agent 修订的" }),
    ],
  });
  const store = new MemoryEntryStore(dir);
  const { muted, restored } = await applyPlan(store, "s1", 3);
  assert.equal(muted, 3);
  assert.equal(restored, 0);
  const scope = byIdOf(await store.listByToken(ws));
  const user = byIdOf(await store.listUser());
  assert.equal(scope.get("mem_full")?.status, "muted");
  assert.equal(scope.get("mem_full")?.mutedReason, MEMORY_MUTED_REVERTED);
  assert.equal(user.get("mem_promoted")?.status, "muted");
  assert.equal(user.get("mem_promoted")?.promotedFrom, ws); // 停用即可，不搬回
  assert.equal(user.get("mem_agent")?.status, "muted");
  for (const id of ["mem_partial", "mem_before", "mem_manual", "mem_edited", "mem_other"]) {
    assert.equal(scope.get(id)?.status, undefined, id);
  }
  assert.equal(scope.get("mem_retired")?.mutedReason, "agent 说不对"); // 不覆盖原理由
});

test("回退停用的连带：被停用条目顶掉的旧条恢复 active（跨层也找得到）；旧条也来自被撤回轮 / 后来又被别的说法顶过的，保守不动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-entries-"));
  const ws = tokenOfScope("ws-1");
  await seedLayers(dir, {
    [ws]: [
      entry({ id: "mem_old", turns: [1], status: "stale", text: "旧说法" }),
      entry({ id: "mem_new", turns: [3], conflictWith: "mem_old", text: "被撤回轮里的新说法" }),
      entry({ id: "mem_oldR", turns: [3], status: "stale", text: "旧条也在被撤回轮里" }),
      entry({ id: "mem_newR", turns: [4], conflictWith: "mem_oldR", text: "更新的说法也被撤回" }),
      entry({ id: "mem_oldD", turns: [1], status: "stale", text: "被两条说法顶过的旧条" }),
      entry({ id: "mem_newD1", turns: [3], conflictWith: "mem_oldD", text: "撤回轮里顶它的" }),
      entry({ id: "mem_newD2", turns: [2], conflictWith: "mem_oldD", status: "stale", text: "没撤回的轮里也顶过它" }),
    ],
    user: [
      entry({ id: "mem_oldU", layer: "user", type: "preference", reason: "r", turns: [1], status: "stale", text: "user 层的旧偏好" }),
    ],
  });
  await appendFile(
    join(dir, `${ws}.jsonl`),
    `${JSON.stringify(entry({ id: "mem_rev", source: "agent", episodeId: "", turns: [5], conflictWith: "mem_oldU", text: "agent 按纠正改的" }))}\n`,
    "utf8",
  );
  const store = new MemoryEntryStore(dir);
  const { restored } = await applyPlan(store, "s1", 3);
  const scope = byIdOf(await store.listByToken(ws));
  const user = byIdOf(await store.listUser());
  assert.equal(scope.get("mem_new")?.status, "muted");
  assert.equal(scope.get("mem_old")?.status, "active");
  assert.equal(scope.get("mem_rev")?.status, "muted");
  assert.equal(user.get("mem_oldU")?.status, "active"); // agent 修订标的 stale 跨层恢复
  assert.equal(scope.get("mem_newR")?.status, "muted");
  assert.equal(scope.get("mem_oldR")?.status, "stale"); // 旧条也来自被撤回轮：不恢复
  assert.equal(scope.get("mem_newD1")?.status, "muted");
  assert.equal(scope.get("mem_oldD")?.status, "stale"); // 后来又被没撤回的说法顶过：不恢复
  assert.equal(restored, 2);
});

test("applyRevert 锁里重判：计划之后用户手改了的条目不再停用；没有变化不碰盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-entries-"));
  const ws = tokenOfScope("ws-1");
  await seedLayers(dir, { [ws]: [entry({ id: "mem_a", turns: [3] })] });
  const store = new MemoryEntryStore(dir);
  const plan = await store.planRevert("s1", 3);
  await store.updateEntry(ws, "mem_a", (current) => ({ ...current, text: "用户改了", editedAt: 5 }));
  const before = await readFile(join(dir, `${ws}.jsonl`), "utf8");
  const outcome = await store.applyRevert(ws, { sessionId: "s1", fromTurn: 3, mute: plan.mute.get(ws)!, restore: new Set() });
  assert.deepEqual(outcome, { muted: 0, restored: 0 });
  assert.equal(await readFile(join(dir, `${ws}.jsonl`), "utf8"), before);
});
