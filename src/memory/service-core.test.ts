/**
 * 记忆服务核心（service-core.ts）——turnSettled 的切段与提取编排、recall 的两层
 * 合并与注入账本、没配模型的静默、启动清扫（闲置追认 / 半路提取续跑）。
 * 纯模块直测（node --test）：模型调用与时间注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryServiceCore, type MemoryCallModel } from "./service-core.ts";
import { EpisodeStore } from "./episodes.ts";
import { MemoryEntryStore } from "./entries.ts";
import { VectorStore } from "./vector-store.ts";
import type { DownloadFetch } from "./downloader.ts";
import { MEMORY_MUTED_REVERTED, memoryShortId, type MemoryChoreModel, type MemoryEntry } from "../shared/memory.ts";

const CHORE: MemoryChoreModel = {
  provider: { id: "p", api: "openai", baseUrl: "https://x", apiKey: "k", models: [] },
  modelId: "chore",
};

/** 模型桩：切段永远按 script 回，提取按 system 提示词里的关键词分派。 */
function stubModel(
  scripts: { segment?: "same" | "new"; replies?: Record<string, string>; failTypes?: string[] },
  opts: { idleMs?: number; now?: () => number } = {},
): {
  core: MemoryServiceCore;
  calls: { system: string; prompt: string }[];
} {
  const calls: { system: string; prompt: string }[] = [];
  const callModel: MemoryCallModel = async (system, prompt) => {
    calls.push({ system, prompt });
    if (scripts.failTypes?.some((keyword) => system.includes(keyword)) === true) return null;
    if (system.includes("切分器")) return scripts.segment ?? "same";
    for (const [keyword, reply] of Object.entries(scripts.replies ?? {})) {
      if (system.includes(keyword)) return reply;
    }
    return "[]";
  };
  const core = new MemoryServiceCore({
    callModel,
    idleCloseMs: opts.idleMs ?? 25,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    log: () => undefined,
  });
  return { core, calls };
}

const FACT_REPLY = JSON.stringify([
  { text: "2026-10-29 用户决定了用 QUMem 的分类法", keywords: ["QUMem"], turns: [1, 2] },
]);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orbita-memory-core-"));
}

function turnPayload(overrides: Record<string, unknown> = {}): Parameters<MemoryServiceCore["turnSettled"]>[0] {
  return {
    sessionId: "s1",
    scopeId: "ws-1",
    turn: 1,
    at: 1000,
    userText: "我们决定用 QUMem 的分类法",
    assistantText: "好的，按事实 / 偏好 / 经验三类拆。",
    chore: CHORE,
    ...overrides,
  } as Parameters<MemoryServiceCore["turnSettled"]>[0];
}

test("第一轮：开新段，不做切段调用，不提取", async () => {
  const { core, calls } = stubModel({});
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload());
  assert.equal(calls.length, 0);
  const store = new EpisodeStore(dir);
  const open = await store.loadOpen("s1");
  assert.equal(open?.turns.length, 1);
});

test("同一事件的两轮并入；判新事件时旧段收尾提取、新段立即落盘", async () => {
  const { core, calls } = stubModel({
    segment: "new",
    replies: { 事实: FACT_REPLY },
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload());
  await core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "换个话题：聊聊部署" }));
  // 切段 1 次 + 提取 3 次
  assert.equal(calls.length, 4);
  assert.ok(calls[0]!.system.includes("切分器"));
  const store = new EpisodeStore(dir);
  // 旧段归档、pending 清空；新段开着，含第 2 轮
  const open = await store.loadOpen("s1");
  assert.equal(open?.fromTurn, 2);
  const log = await readFile(join(dir, "episodes", "log.jsonl"), "utf8");
  assert.equal(log.trim().split("\n").length, 1);
  // 事实落进了工作区层
  const scopeFiles = (await readdir(dir)).filter((name) => name.endsWith(".jsonl") && name !== "injections.jsonl");
  assert.equal(scopeFiles.length, 1);
  const raw = await readFile(join(dir, scopeFiles[0]!), "utf8");
  assert.ok(raw.includes("QUMem"));
  // 判 same 的对照组：只切段 1 次，没有提取
  const sameModel = stubModel({ segment: "same", replies: { 事实: FACT_REPLY } });
  await sameModel.core.init(await tempDir(), CHORE);
  await sameModel.core.turnSettled(turnPayload());
  await sameModel.core.turnSettled(turnPayload({ turn: 2, at: 2000 }));
  assert.equal(sameModel.calls.length, 1);
});

test("间隔超 30 分钟：不问模型直接切段", async () => {
  const { core, calls } = stubModel({ replies: { 事实: "[]" } });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload());
  await core.turnSettled(turnPayload({ turn: 2, at: 1000 + 31 * 60_000, userText: "隔天的新话题" }));
  // 没有切段调用（间隔判新事件），直接 3 次提取
  assert.equal(calls.length, 3);
  assert.ok(!calls[0]!.system.includes("切分器"));
});

test("没配家务活模型：不构建、日志一次、chore 来了恢复", async () => {
  const { core, calls } = stubModel({});
  const dir = await tempDir();
  await core.init(dir);
  const logs: string[] = [];
  // 换一个带日志收集的核
  const core2 = new MemoryServiceCore({
    callModel: async () => "[]",
    idleCloseMs: 25,
    log: (message) => logs.push(message),
  });
  await core2.init(dir);
  await core2.turnSettled(turnPayload({ chore: undefined }));
  await core2.turnSettled(turnPayload({ chore: undefined, turn: 2, at: 2000 }));
  assert.equal(logs.filter((line) => line.includes("家务活模型")).length, 1); // 只提醒一次
  const store = new EpisodeStore(dir);
  assert.equal(await store.loadOpen("s1"), null); // 什么都没落
  // chore 来了：下一轮正常开段
  await core2.turnSettled(turnPayload({ turn: 3, at: 3000 }));
  assert.notEqual(await store.loadOpen("s1"), null);
  assert.equal(calls.length, 0);
});

test("recall：两层合并 + 注入账本每轮一条（含零命中）", async () => {
  const { core } = stubModel({});
  const dir = await tempDir();
  await core.init(dir, CHORE);
  // 手工放一条 user 层偏好（常驻）与一条工作区层事实（词法）
  const store = new EpisodeStore(dir);
  await store.saveOpen({
    episodeId: "ep_seed",
    sessionId: "seed",
    scopeId: "ws-1",
    fromTurn: 1,
    toTurn: 1,
    openedAt: 1,
    lastAt: 1,
    turns: [{ turn: 1, at: 1, userText: "seed", assistantText: "seed" }],
    extracted: { fact: false, preference: false, insight: false },
  });
  await core.turnSettled({
    ...turnPayload(),
    userText: "记住我喜欢用中文回复",
  });
  // 直接往工作区层文件里补一条带关键词的事实，测词法通道
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("ws-1", {
    episodeId: "ep_seed",
    sessionId: "seed",
    scopeId: "ws-1",
    fromTurn: 1,
    toTurn: 1,
    openedAt: 1,
    lastAt: 1,
    turns: [{ turn: 1, at: 1, userText: "seed", assistantText: "seed" }],
  }, [{ type: "fact", text: "orbita 的包管理器是 bun", keywords: ["bun"], turns: [1] }]);
  const hits = await core.recall({ sessionId: "s9", scopeId: "ws-1", turn: 1, query: "bun 装依赖" });
  assert.ok(hits.some((hit) => hit.entry.text.includes("bun")));
  const zero = await core.recall({ sessionId: "s9", scopeId: "ws-1", turn: 2, query: "完全不相关的问题" });
  assert.equal(zero.length, 0);
  const ledger = await readFile(join(dir, "injections.jsonl"), "utf8");
  const rows = ledger.trim().split("\n").map((line) => JSON.parse(line) as { hits: unknown[] });
  assert.equal(rows.length, 2); // 零命中也记账
  assert.equal(rows[1]?.hits.length, 0);
});

test("启动清扫：闲置开段追认收尾（应用退出的兜底）", async () => {
  // 第一段：闲置超时收尾
  const first = stubModel({ replies: { 事实: FACT_REPLY } });
  const dir = await tempDir();
  await first.core.init(dir, CHORE);
  await first.core.turnSettled(turnPayload());
  const store = new EpisodeStore(dir);
  // idleCloseMs = 25：轮询等收尾（固定睡 60ms 在全量测试的负载下会偶发不够——
  // 启动时多了一次旧数据落定、提取落盘多一把锁，异步步数变多）。要等到 pending/ 也清空：
  // 闲置收尾是「存 pending → 删开段 → 提取」，只等开段消失会在提取还没跑完时就重启，
  // 下面第二个服务的启动清扫会把这第一段剩下的类也提一遍（全量负载下偶发 3 !== 2）
  const settled = async (): Promise<boolean> =>
    (await store.loadOpen("s1")) === null && (await store.listPending()).length === 0;
  for (let waited = 0; waited < 2000 && !(await settled()); waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(await settled()); // 收尾提完了
  // 第二段：重启清扫把还没提的类补完（fact 提成、preference/insight 还欠着）
  await store.savePending({
    episodeId: "ep_half",
    sessionId: "s1",
    scopeId: "ws-1",
    fromTurn: 1,
    toTurn: 1,
    openedAt: 1,
    lastAt: Date.now(),
    turns: [{ turn: 1, at: Date.now(), userText: "半路提取的段", assistantText: "答" }],
    extracted: { fact: true, preference: false, insight: false },
  });
  const second = stubModel({ replies: { 偏好: "[]", 经验: "[]" } });
  await second.core.init(dir, CHORE);
  // 只补了 preference / insight 两类，fact 不重提
  const extractCalls = second.calls.filter((call) => !call.system.includes("切分器"));
  assert.equal(extractCalls.length, 2);
  assert.equal(await store.loadPending("ep_half"), null);
});

test("某类提取失败：记账不动，该会话下一轮落定时重试且不重提成类", async () => {
  const replies: Record<string, string> = { 事实: FACT_REPLY, 偏好: "[]", 经验: "[]" };
  let clock = 1000;
  const first = stubModel({ segment: "new", replies, failTypes: ["偏好"] }, { idleMs: 60_000, now: () => clock });
  const dir = await tempDir();
  await first.core.init(dir, CHORE);
  await first.core.turnSettled(turnPayload({ userText: "第一件事" }));
  clock = 2000;
  await first.core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "第二件事" }));
  // fact 成了、preference 失败、insight 成了
  const store = new EpisodeStore(dir);
  const pendingNames = await readdir(join(dir, "episodes", "pending"));
  assert.equal(pendingNames.length, 1);
  // 同一会话下一轮：先补 pending（偏好这次不失败），再切段新段
  const second = stubModel({ segment: "same", replies });
  const core2 = new MemoryServiceCore({
    callModel: async (system) => {
      for (const [keyword, reply] of Object.entries(replies)) {
        if (system.includes(keyword)) return reply;
      }
      return "same";
    },
    idleCloseMs: 60_000,
    now: () => clock,
    log: () => undefined,
  });
  await core2.init(dir, CHORE);
  clock = 3000;
  await core2.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "继续第二件事" }));
  assert.equal((await readdir(join(dir, "episodes", "pending")).catch(() => [] as string[])).length, 0); // 补完归档了
  const log = await readFile(join(dir, "episodes", "log.jsonl"), "utf8");
  assert.equal(log.trim().split("\n").length, 1);
});

/* ---------- 记忆库写操作（mutate）与 changed 通知 ---------- */

test("mutate：edit / remove / setStatus / addManual 的落盘与回执", async () => {
  const changes: number[] = [];
  const core = new MemoryServiceCore({
    callModel: async () => null,
    idleCloseMs: 60_000,
    log: () => undefined,
    onChanged: () => changes.push(1),
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);

  const added = await core.mutate({
    op: "addManual",
    token: "user",
    type: "preference",
    text: "回复一律用中文",
    reason: "用户手动记的",
    scopeId: undefined,
  });
  assert.equal(added.ok, true);
  const entryId = added.ok && added.entry ? added.entry.id : "";
  assert.notEqual(entryId, "");

  const edited = await core.mutate({ op: "edit", token: "user", entryId, text: "回复优先用中文" });
  assert.equal(edited.ok && edited.entry?.text, "回复优先用中文");
  assert.notEqual(edited.ok && edited.entry?.editedAt, undefined);

  const muted = await core.mutate({ op: "setStatus", token: "user", entryId, status: "muted" });
  assert.equal(muted.ok && muted.entry?.status, "muted");

  // 偏好没 reason 的 manual 拒收；目标不在的 edit 拒收
  assert.equal((await core.mutate({ op: "addManual", token: "user", type: "preference", text: "没理由" })).ok, false);
  assert.equal(
    (await core.mutate({ op: "edit", token: "user", entryId: "mem_不存在", text: "x" })).ok,
    false,
  );

  const removed = await core.mutate({ op: "remove", token: "user", entryId });
  assert.equal(removed.ok, true);
  // addManual + edit + setStatus + remove 四次成功落盘各通知一次；两次拒收不通知
  assert.equal(changes.length, 4);
});

const SEED_EPISODE = {
  episodeId: "ep_seed", sessionId: "s1", scopeId: "ws-1", fromTurn: 1, toTurn: 2, openedAt: 1, lastAt: 2,
  turns: [
    { turn: 1, at: 1, userText: "u", assistantText: "a" },
    { turn: 2, at: 2, userText: "u2", assistantText: "a2" },
  ],
};

test("提取直接落定：跨工作区偏好进 user 层、冲突的旧偏好标 stale，不留任何待确认", async () => {
  const dir = await tempDir();
  const entries = new MemoryEntryStore(dir);
  const [old] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "用户要求汇报写成长段落", reason: "r", keywords: ["汇报"], turns: [1] },
  ]);
  const { core } = stubModel({
    segment: "new",
    replies: {
      "提取「偏好」": JSON.stringify([
        { text: "用户要求汇报写成三条要点", reason: "用户改了主意", keywords: ["汇报"], turns: [1], conflictsWith: old!.id },
        { text: "用户要求回复一律用中文", reason: "用户说所有项目都这样", keywords: ["中文"], turns: [1], crossWorkspace: true },
      ]),
    },
  });
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload({ turn: 1, at: 1000, userText: "汇报改成三条要点；回复都用中文" }));
  await core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "换个话题" }));
  const scope = await entries.listScope("ws-1");
  const user = await entries.listUser();
  assert.equal(scope.find((item) => item.id === old!.id)?.status, "stale");
  const fresh = scope.find((item) => item.text === "用户要求汇报写成三条要点");
  assert.equal(fresh?.conflictWith, old!.id);
  assert.equal(fresh?.status, undefined);
  const promoted = user.find((item) => item.text === "用户要求回复一律用中文");
  assert.equal(promoted?.layer, "user");
  assert.equal(promoted?.promotedFrom, entries.tokenOf("ws-1"));
});

test("mutate restorePrevious：旧说法回 active、新条 muted（不删）；旧条已删拒收", async () => {
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const wsToken = entries.tokenOf("ws-1");
  const [old] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "旧偏好", reason: "r", keywords: [], turns: [1] },
  ]);
  const [fresh] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "新偏好", reason: "r", keywords: [], turns: [2], conflictWith: old!.id },
  ]);
  assert.equal((await entries.listByToken(wsToken)).find((e) => e.id === old!.id)?.status, "stale");

  const restored = await core.mutate({ op: "restorePrevious", token: wsToken, entryId: fresh!.id });
  assert.equal(restored.ok && restored.entry?.status, "muted");
  const after = await entries.listByToken(wsToken);
  assert.equal(after.find((e) => e.id === old!.id)?.status, "active");
  assert.equal(after.length, 2); // 新条还在，演变链照常可见

  // 没有 conflictWith 的拒收；旧条删了拒收且不动新条
  assert.equal((await core.mutate({ op: "restorePrevious", token: wsToken, entryId: old!.id })).ok, false);
  await entries.removeEntry(wsToken, old!.id);
  await entries.updateEntry(wsToken, fresh!.id, (e) => ({ ...e, status: "active" }));
  assert.equal((await core.mutate({ op: "restorePrevious", token: wsToken, entryId: fresh!.id })).ok, false);
  assert.equal((await entries.listByToken(wsToken)).find((e) => e.id === fresh!.id)?.status, "active");
});

test("mutate restorePrevious：新条自动升到 user 层、旧条在原作用域——也找得到旧条", async () => {
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const [old] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "旧的回复语言", reason: "r", keywords: [], turns: [1] },
  ]);
  const [fresh] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "回复一律中文", reason: "r", keywords: [], turns: [2], conflictWith: old!.id, crossWorkspace: true },
  ]);
  assert.equal(fresh?.layer, "user");
  const restored = await core.mutate({ op: "restorePrevious", token: "user", entryId: fresh!.id });
  assert.equal(restored.ok, true);
  assert.equal((await entries.listScope("ws-1")).find((e) => e.id === old!.id)?.status, "active");
});

test("mutate returnToWorkspace：自动升层的条目搬回原作用域、promotedFrom 清掉；不是升上来的拒收", async () => {
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const wsToken = entries.tokenOf("ws-1");
  const [promoted] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "跨工作区偏好", reason: "r", keywords: [], turns: [1], crossWorkspace: true },
  ]);
  const back = await core.mutate({ op: "returnToWorkspace", token: "user", entryId: promoted!.id });
  assert.equal(back.ok && back.entry?.layer, "workspace");
  assert.equal(back.ok && back.entry?.promotedFrom, undefined);
  assert.equal((await entries.listUser()).length, 0);
  assert.equal((await entries.listByToken(wsToken)).length, 1);
  // 已经搬回的再来一次、手动加在 user 层的：都拒收
  assert.equal((await core.mutate({ op: "returnToWorkspace", token: wsToken, entryId: promoted!.id })).ok, false);
  const manual = await core.mutate({ op: "addManual", token: "user", type: "fact", text: "手动的" });
  assert.equal(
    (await core.mutate({ op: "returnToWorkspace", token: "user", entryId: manual.ok && manual.entry ? manual.entry.id : "" })).ok,
    false,
  );
});

test("setStatus active：agent 停用时记的理由随之清掉", async () => {
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const [seeded] = await entries.appendScope("ws-1", SEED_EPISODE, [{ type: "fact", text: "某事实", keywords: [], turns: [1] }]);
  const retired = await core.agentTool({ sessionId: "s1", scopeId: "ws-1", turn: 3, call: { op: "retire", entryId: seeded!.id, reason: "用户说不对" } });
  assert.equal(retired.ok && retired.entries[0]?.mutedReason, "用户说不对");
  const back = await core.mutate({ op: "setStatus", token: entries.tokenOf("ws-1"), entryId: seeded!.id, status: "active" });
  assert.equal(back.ok && back.entry?.status, "active");
  assert.equal(back.ok && back.entry?.mutedReason, undefined);
});

test("agentTool revise：按短 id 定位、旧条 stale、新条 agent 来源带出处轮；写盘通知一次", async () => {
  const changes: number[] = [];
  const core = new MemoryServiceCore({
    callModel: async () => null,
    idleCloseMs: 60_000,
    now: () => 9000,
    log: () => undefined,
    onChanged: () => changes.push(1),
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const [old] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "用户要求汇报写成长段落", reason: "r", keywords: ["汇报"], turns: [1] },
  ]);
  const before = changes.length;
  const outcome = await core.agentTool({
    sessionId: "s7",
    scopeId: "ws-1",
    turn: 4,
    call: { op: "revise", entryId: memoryShortId(old!.id), text: "用户要求汇报写成三条要点", reason: "用户说不对" },
  });
  assert.equal(outcome.ok, true);
  const [fresh, staled] = outcome.ok ? outcome.entries : [];
  assert.equal(fresh?.source, "agent");
  assert.equal(fresh?.sessionId, "s7");
  assert.deepEqual(fresh?.turns, [4]);
  assert.equal(fresh?.at, 9000);
  assert.equal(fresh?.conflictWith, old!.id);
  assert.equal(staled?.status, "stale");
  assert.equal(changes.length - before, 1);
  // 召回只认新说法
  const hits = await core.recall({ sessionId: "s7", scopeId: "ws-1", turn: 5, query: "汇报怎么写" });
  assert.deepEqual(hits.map((hit) => hit.entry.text), ["用户要求汇报写成三条要点"]);
  // 再修订已过时的旧条：报「被谁顶掉了」，不分叉
  const again = await core.agentTool({
    sessionId: "s7", scopeId: "ws-1", turn: 5,
    call: { op: "revise", entryId: old!.id, text: "别的说法", reason: "r" },
  });
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.error, new RegExp(memoryShortId(fresh!.id)));
});

test("agentTool：可见范围只有 user 层 + 本作用域；找不到 / 太短 / 一字不差 / 空理由都拒", async () => {
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const [other] = await entries.appendScope("ws-2", { ...SEED_EPISODE, scopeId: "ws-2" }, [
    { type: "fact", text: "别的工作区的事", keywords: [], turns: [1] },
  ]);
  const [mine] = await entries.appendScope("ws-1", SEED_EPISODE, [{ type: "fact", text: "本工作区的事", keywords: [], turns: [1] }]);
  const call = (entryId: string, text = "改过", reason = "r") =>
    core.agentTool({ sessionId: "s1", scopeId: "ws-1", turn: 2, call: { op: "revise", entryId, text, reason } });
  assert.equal((await call(other!.id)).ok, false); // 别的工作区：不可改
  assert.equal((await entries.listScope("ws-2"))[0]?.status, undefined);
  assert.equal((await call("mem_")).ok, false); // 前缀太短，不猜
  assert.equal((await call(mine!.id, "本工作区的事")).ok, false); // 一字不差
  assert.equal((await call(mine!.id, "改过", " ")).ok, false); // 没理由
  assert.equal((await call(mine!.id)).ok, true);
});

test("agentTool search：只回 active、按相关度；retire 标 muted 并记理由", async () => {
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const [a, b] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "fact", text: "用户的项目用 bun 管依赖", keywords: ["bun", "依赖"], turns: [1] },
    { type: "fact", text: "用户的周报每周五发", keywords: ["周报"], turns: [1] },
  ]);
  const found = await core.agentTool({ sessionId: "s1", scopeId: "ws-1", turn: 2, call: { op: "search", query: "依赖用什么管" } });
  assert.deepEqual(found.ok ? found.entries.map((item) => item.id) : null, [a!.id]);
  const retired = await core.agentTool({ sessionId: "s1", scopeId: "ws-1", turn: 2, call: { op: "retire", entryId: a!.id, reason: "用户说早换成 pnpm 了" } });
  assert.equal(retired.ok && retired.entries[0]?.status, "muted");
  const again = await core.agentTool({ sessionId: "s1", scopeId: "ws-1", turn: 2, call: { op: "search", query: "依赖用什么管" } });
  assert.deepEqual(again.ok ? again.entries : null, []);
  assert.equal((await entries.listScope("ws-1")).find((item) => item.id === b!.id)?.status, undefined);
});

test("agentTool search：没有关键词的手动条目也搜得到——检索句覆盖了条目就算命中（实例实测的回归）", async () => {
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const wsToken = entries.tokenOf("ws-1");
  const manual = await entries.addManual(wsToken, { type: "preference", text: "用户喝咖啡只喝美式", reason: "r", now: 1 });
  await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "用户写汇报的格式要求", reason: "r", keywords: ["写作习惯"], turns: [1] },
  ]);
  const found = await core.agentTool({
    sessionId: "s1", scopeId: "ws-1", turn: 2,
    call: { op: "search", query: "用户喝咖啡的习惯 美式" },
  });
  assert.equal(found.ok && found.entries[0]?.id, manual!.id);
  // 实例实测第二例：短检索句只有一个字对得上（「猫」对「橘猫」）
  const cat = await entries.addManual(wsToken, { type: "fact", text: "用户养了一只叫团子的橘猫", now: 1 });
  for (const query of ["猫的名字 团子", "猫 宠物 名字"]) {
    const hit = await core.agentTool({ sessionId: "s1", scopeId: "ws-1", turn: 2, call: { op: "search", query } });
    assert.equal(hit.ok && hit.entries[0]?.id, cat!.id, query);
  }
});

test("提取：本段里 agent 当场修订过的条目进三类提示词的 <recorded> 节", async () => {
  const dir = await tempDir();
  const { core, calls } = stubModel({ segment: "new" }, { now: () => 5000 });
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  const [old] = await entries.appendScope("ws-1", SEED_EPISODE, [
    { type: "preference", text: "用户要求汇报写成长段落", reason: "r", keywords: ["汇报"], turns: [1] },
  ]);
  await core.turnSettled(turnPayload({ turn: 1, at: 1000, userText: "不对，汇报要三条要点" }));
  await core.agentTool({
    sessionId: "s1", scopeId: "ws-1", turn: 1,
    call: { op: "revise", entryId: old!.id, text: "用户要求汇报写成三条要点", reason: "用户纠正" },
  });
  await core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "换个话题" }));
  const extractCalls = calls.filter((call) => call.system.includes("记忆提取器"));
  assert.equal(extractCalls.length, 3);
  for (const call of extractCalls) assert.ok(call.prompt.includes("<recorded>\n- 用户要求汇报写成三条要点"));
});

test("init：旧数据里没拍板的待确认按新规则落定一次", async () => {
  const dir = await tempDir();
  const entries = new MemoryEntryStore(dir);
  const token = entries.tokenOf("ws-1");
  const row = {
    id: "mem_legacy", type: "preference", text: "回复用中文", reason: "r", keywords: [], layer: "workspace",
    scopeId: "ws-1", sessionId: "s1", turns: [1], at: 1, episodeId: "ep", source: "chat", pendingPromote: true,
  };
  await writeFile(join(dir, `${token}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
  const logs: string[] = [];
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: (message) => logs.push(message) });
  await core.init(dir, CHORE);
  assert.equal((await entries.listUser())[0]?.id, "mem_legacy");
  assert.ok(logs.some((line) => line.includes("升到所有工作区 1 条")));
});

test("changed：提取落条目 / 事件段收尾也通知（不只是 mutate）", async () => {
  const changes: number[] = [];
  const core = new MemoryServiceCore({
    callModel: async () => "[]",
    idleCloseMs: 60_000,
    log: () => undefined,
    onChanged: () => changes.push(1),
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload({ userText: "第一件事" }));
  assert.equal(changes.length, 1); // 开段落盘
  const before = changes.length;
  await core.turnSettled(turnPayload({ turn: 2, at: 1000 + 31 * 60_000, userText: "隔天新话题" }));
  // split 收尾（1）+ 三类提取各落一次（3）+ 归档（1）
  assert.equal(changes.length - before >= 4, true);
});

/* ---------- 向量召回（setVectorConfig / 补算 / 融合 / 电池推迟 / 下载） ---------- */

import type { MemoryDownloadProgress, MemoryEpisode } from "../shared/memory.ts";

/** 向量测试用的段夹具（条目落盘要带出处）。 */
function vectorEpisode(): MemoryEpisode {
  return {
    episodeId: "ep_vec",
    sessionId: "s1",
    scopeId: "ws-1",
    fromTurn: 1,
    toTurn: 1,
    openedAt: 1,
    lastAt: 1,
    turns: [{ turn: 1, at: 1, userText: "u", assistantText: "a" }],
  };
}

const VECTOR_MODEL = {
  id: "embeddinggemma-2" as const,
  repo: "ggml-org/embeddinggemma-2-GGUF",
  file: "embeddinggemma-2-Q8_0.gguf",
  sha256: "x",
  sizeBytes: 1,
  pooling: "mean" as const,
  ctx: 8192,
  queryPrefix: "task: search result | query: ",
  docPrefix: "title: none | text: ",
  dims: 4,
  // 桩向量的余弦分布与真模型无关：既有融合测试不设下限，下限另有专门的测试
  minCosine: 0,
};

/** 向量原语桩：embed 按文本哈希出确定向量（同文本同向量），可探查调用参数。 */
function vectorStub(embed?: (text: string) => number[]) {
  const embeddedTexts: string[] = [];
  let running = true;
  return {
    embeddedTexts,
    setRunning(value: boolean) {
      running = value;
    },
    deps: {
      spawn: () => ({
        on: () => undefined,
        kill: () => undefined,
      }),
      probe: async () => true,
      post: async (_port: number, texts: readonly string[]) =>
        texts.map((text) => {
          embeddedTexts.push(text);
          if (embed !== undefined) return embed(text);
          const seed = Array.from(text).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
          return [seed % 7 + 1, seed % 5, seed % 3, 1];
        }),
      freePort: async () => 8999,
      fetchImpl: (async () => ({ ok: false, status: 0, body: null })) as DownloadFetch,
    },
    isRunning: () => running,
  };
}

function vectorCore(dir: string, stub: ReturnType<typeof vectorStub>, extra: { onBackfillProgress?: (p: { state: string; done: number; total: number }) => void } = {}) {
  const progress: MemoryDownloadProgress[] = [];
  const core = new MemoryServiceCore({
    callModel: async () => "[]",
    idleCloseMs: 60_000,
    log: () => undefined,
    onChanged: () => undefined,
    onDownloadProgress: (p) => progress.push(p),
    onBackfillProgress: extra.onBackfillProgress ?? (() => undefined),
    vectorDeps: stub.deps,
  });
  void dir;
  return { core, progress };
}

test("setVectorConfig：补算给已有条目算向量（带文档前缀），muted 不算", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const { core } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  // 先落两条条目（一条 muted）
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("ws-1", vectorEpisode(), [
    { type: "fact", text: "orbita 用 bun", keywords: [], turns: [1] },
    { type: "fact", text: "被关掉的", keywords: [], turns: [1] },
  ]);
  const all = await entries.listByToken(entries.tokenOf("ws-1"));
  await entries.updateEntry(entries.tokenOf("ws-1"), all[1]!.id, (current) => ({ ...current, status: "muted" }));

  core.setVectorConfig({
    model: VECTOR_MODEL,
    ggufPath: "/models/m.gguf",
    binaryPath: "/bin/llama-server",
    idleUnloadMs: 300_000,
    deferOnBattery: true,
  });
  // 补算是异步的：等它收尾（轮询 backfill 状态回 null）
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = await core.vectorState();
    if (state.backfill === null && state.vectors !== null) break;
  }
  const state = await core.vectorState();
  assert.equal(state.vectors?.entries, 1); // muted 的不算
  assert.equal(state.llamaRunning, true); // probe 桩恒真
  assert.ok(stub.embeddedTexts.some((text) => text.startsWith(VECTOR_MODEL.docPrefix)));
});

test("补算全量对账：每个条目层文件只读一遍，缺的向量照样补齐", async (t) => {
  const dir = await tempDir();
  const stub = vectorStub();
  // 对账读盘在第一条 running 进度之前做完：那一刻拍下读盘计数（之后的 vectorState 轮询也读层，不算补算的）
  let readsAtRunning: string[] | null = null;
  let finished: () => void = () => undefined;
  const idle = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let spy: { mock: { calls: { arguments: unknown[] }[] } } | null = null;
  const { core } = vectorCore(dir, stub, {
    onBackfillProgress: (progress) => {
      if (progress.state === "running" && readsAtRunning === null && spy !== null) {
        readsAtRunning = spy.mock.calls.map((call) => String(call.arguments[0]));
      }
      if (progress.state === "idle") finished();
    },
  });
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("ws-1", vectorEpisode(), [{ type: "fact", text: "orbita 用 bun", keywords: [], turns: [1] }]);
  await entries.appendScope("ws-2", vectorEpisode(), [{ type: "fact", text: "另一个工作区的事实", keywords: [], turns: [1] }]);
  await entries.addManual("user", { type: "preference", text: "本地优先", reason: "r", now: 1 });
  // 计数桩：readLayer 是条目层唯一的读盘口
  spy = t.mock.method(
    MemoryEntryStore.prototype as unknown as { readLayer: (path: string) => Promise<MemoryEntry[]> },
    "readLayer",
  );
  core.setVectorConfig({
    model: VECTOR_MODEL,
    ggufPath: "/models/m.gguf",
    binaryPath: "/bin/llama-server",
    idleUnloadMs: 300_000,
    deferOnBattery: true,
  });
  await idle;
  assert.equal((await core.vectorState()).vectors?.entries, 3);
  assert.ok(readsAtRunning !== null);
  const counts = new Map<string, number>();
  for (const path of readsAtRunning as string[]) counts.set(path, (counts.get(path) ?? 0) + 1);
  assert.equal(counts.size, 3);
  for (const [path, count] of counts) assert.equal(count, 1, `补算把 ${path} 读了 ${count} 遍`);
});

test("recall 融合：向量命中但词法没命中的条目也能进结果", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const { core } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  // 两条条目：一条词法可命中（关键词），一条只有向量能对上（embed 桩按文本出向量，
  // query 与条目同文本 → 同向量 → 点积最大）
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("ws-1", vectorEpisode(), [
    { type: "fact", text: "语义记忆条目", keywords: ["完全无关的关键词"], turns: [1] },
  ]);
  core.setVectorConfig({
    model: VECTOR_MODEL,
    ggufPath: "/models/m.gguf",
    binaryPath: "/bin/llama-server",
    idleUnloadMs: 300_000,
    deferOnBattery: true,
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).backfill === null) break;
  }
  // query 与条目文本一致：embed 桩同文本同向量 → 向量第一名；词法零命中
  const hits = await core.recall({ sessionId: "s", scopeId: "ws-1", turn: 1, query: "语义记忆条目" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.entry.text, "语义记忆条目");
});

test("recall 融合：余弦低于模型下限的不进融合——无关问句不再被注满", async () => {
  const dir = await tempDir();
  // 条目向量 [1,0,0,0]；相关问句余弦 0.8，无关问句 0.4（下限 0.5）
  const stub = vectorStub((text) => {
    if (text.includes("无关")) return [0.4, Math.sqrt(1 - 0.16), 0, 0];
    if (text.includes("相关")) return [0.8, 0.6, 0, 0];
    return [1, 0, 0, 0];
  });
  const { core } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("ws-1", vectorEpisode(), [
    { type: "fact", text: "一条语义记忆", keywords: ["词法对不上的关键词"], turns: [1] },
  ]);
  core.setVectorConfig({
    model: { ...VECTOR_MODEL, minCosine: 0.5 },
    ggufPath: "/models/m.gguf",
    binaryPath: "/bin/llama-server",
    idleUnloadMs: 300_000,
    deferOnBattery: true,
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).backfill === null) break;
  }
  const unrelated = await core.recall({ sessionId: "s", scopeId: "ws-1", turn: 1, query: "完全无关的问句" });
  assert.deepEqual(unrelated, []);
  const related = await core.recall({ sessionId: "s", scopeId: "ws-1", turn: 2, query: "相关的问句" });
  assert.deepEqual(related.map((hit) => hit.entry.text), ["一条语义记忆"]);
});

test("recall 融合：user 与 scope 的向量按相似度全局排序，不按层拼名次", async () => {
  const dir = await tempDir();
  const stub = vectorStub((text) =>
    text.includes("工作区目标") || text.includes("完全无关的问句") ? [1, 0, 0, 0] : [0, 1, 0, 0],
  );
  const { core } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  await core.mutate({ op: "addManual", token: "user", type: "fact", text: "user-a" });
  await core.mutate({ op: "addManual", token: "user", type: "fact", text: "user-b" });
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("ws-1", vectorEpisode(), [
    { type: "fact", text: "工作区目标", keywords: [], turns: [1] },
  ]);
  core.setVectorConfig({ model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = await core.vectorState();
    if (state.backfill === null && state.vectors?.entries === 3) break;
  }
  const hits = await core.recall({ sessionId: "s", scopeId: "ws-1", turn: 1, query: "完全无关的问句" });
  assert.equal(hits[0]?.entry.text, "工作区目标");
});

test("recall 融合：muted / stale 不借向量复活，user 偏好仍常驻且只出现一次", async () => {
  const dir = await tempDir();
  const stub = vectorStub(() => [1, 0, 0, 0]);
  const { core } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  const pinned = await core.mutate({
    op: "addManual",
    token: "user",
    type: "preference",
    text: "跨工作区常驻偏好",
    reason: "用户明确要求",
  });
  const pinnedId = pinned.ok && pinned.entry ? pinned.entry.id : "";
  const entries = new MemoryEntryStore(dir);
  const wsToken = entries.tokenOf("ws-1");
  const seeded = await entries.appendScope("ws-1", vectorEpisode(), [
    { type: "fact", text: "将被关闭", keywords: [], turns: [1] },
    { type: "fact", text: "将标过时", keywords: [], turns: [1] },
    { type: "fact", text: "正常条目", keywords: [], turns: [1] },
  ]);
  core.setVectorConfig({ model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = await core.vectorState();
    if (state.backfill === null && state.vectors?.entries === 4) break;
  }
  await core.mutate({ op: "setStatus", token: wsToken, entryId: seeded[0]!.id, status: "muted" });
  await entries.updateEntry(wsToken, seeded[1]!.id, (current) => ({ ...current, status: "stale" }));
  const hits = await core.recall({ sessionId: "s", scopeId: "ws-1", turn: 1, query: "没有词法重合" });
  assert.equal(hits[0]?.entry.id, pinnedId);
  assert.equal(hits[0]?.pinned, true);
  assert.equal(hits.filter((hit) => hit.entry.id === pinnedId).length, 1);
  assert.equal(hits.some((hit) => hit.entry.id === seeded[0]!.id), false);
  assert.equal(hits.some((hit) => hit.entry.id === seeded[1]!.id), false);
});

test("recall 融合：候选再多也只回 5 条，沿用词法注入上限", async () => {
  const dir = await tempDir();
  const stub = vectorStub(() => [1, 0, 0, 0]);
  const { core } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  // 各来自不同事件段：同一段同一轮里六条几乎同文的会被当成同源复述只留一条（另有专门的测试）
  for (let index = 0; index < 6; index += 1) {
    await entries.appendScope("ws-1", { ...vectorEpisode(), episodeId: `ep_vec_${index}` }, [
      { type: "fact", text: `语义候选 ${index}`, keywords: [], turns: [1] },
    ]);
  }
  core.setVectorConfig({ model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = await core.vectorState();
    if (state.backfill === null && state.vectors?.entries === 6) break;
  }
  const hits = await core.recall({ sessionId: "s", scopeId: "ws-1", turn: 1, query: "词法零命中" });
  assert.equal(hits.length, 5);
});

test("电池推迟：onBattery 时挂起，回电源续跑", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const states: string[] = [];
  const { core } = vectorCore(dir, stub, { onBackfillProgress: (p) => states.push(p.state) });
  await core.init(dir, CHORE);
  const entries = new MemoryEntryStore(dir);
  await entries.appendScope("ws-1", vectorEpisode(), [{ type: "fact", text: "等电池的条目", keywords: [], turns: [1] }]);
  core.setPower(true);
  core.setVectorConfig({
    model: VECTOR_MODEL,
    ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await core.vectorState()).backfill?.state, "deferred-battery");
  core.setPower(false); // 回电源 → 续跑
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).backfill === null) break;
  }
  assert.equal((await core.vectorState()).vectors?.entries, 1);
  assert.ok(states.includes("running"));
});

test("mutate edit：向量行删掉后由补算重算（换文本换向量）", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const { core } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  const added = await core.mutate({ op: "addManual", token: "user", type: "fact", text: "改之前的文本" });
  const id = added.ok && added.entry ? added.entry.id : "";
  core.setVectorConfig({ model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).backfill === null) break;
  }
  assert.equal((await core.vectorState()).vectors?.entries, 1);
  await core.mutate({ op: "edit", token: "user", entryId: id, text: "改之后的文本" });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).backfill === null) break;
  }
  assert.ok(stub.embeddedTexts.includes(VECTOR_MODEL.docPrefix + "改之后的文本"));
});

test("补算在跑时新增条目：记录补跑，当前轮结束后新条目也有向量", async () => {
  const dir = await tempDir();
  const core = new MemoryServiceCore({
    callModel: async () => "[]",
    log: () => undefined,
    vectorDeps: {
      spawn: () => ({ on: () => undefined, kill: () => undefined }),
      probe: async () => true,
      post: async (_port, texts) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return texts.map(() => [1, 0, 0, 0]);
      },
      freePort: async () => 1,
      fetchImpl: async () => ({ ok: false, status: 0, body: null }),
    },
  });
  await core.init(dir);
  for (let index = 0; index < 33; index += 1) {
    await core.mutate({ op: "addManual", token: "user", type: "fact", text: `old-${index}` });
  }
  const config = { model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 1_000_000, deferOnBattery: false };
  core.setVectorConfig(config);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const late = await core.mutate({ op: "addManual", token: "user", type: "fact", text: "late" });
  const lateId = late.ok && late.entry ? late.entry.id : "";
  for (let index = 0; index < 80; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const layer = await new VectorStore(join(dir, "vector")).load("user", VECTOR_MODEL.dims);
    if (layer?.ids.includes(lateId)) return;
  }
  assert.fail("补算结束后，迟到条目仍没有向量");
});

test("setVectorConfig：配置没变不做全量对账，也不广播 idle", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const states: string[] = [];
  const { core } = vectorCore(dir, stub, { onBackfillProgress: (progress) => states.push(progress.state) });
  await core.init(dir);
  const config = { model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true };
  core.setVectorConfig(config);
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).backfill === null) break;
  }
  const posts = stub.embeddedTexts.length;
  states.length = 0;
  core.setVectorConfig({ ...config, model: { ...VECTOR_MODEL } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stub.embeddedTexts.length, posts);
  assert.deepEqual(states, []);
});

test("startModelDownload：进度事件流出（桩源全挂 → failed 事件）", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const { core, progress } = vectorCore(dir, stub);
  await core.init(dir, CHORE);
  core.startModelDownload({
    requestId: "req-1",
    sources: ["https://down.example/m.gguf"],
    targetPath: join(dir, "vector", "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 10,
  });
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (progress.some((p) => p.phase === "failed")) break;
  }
  assert.ok(progress.some((p) => p.phase === "failed"));
});

/** 下载桩：fetch 挂住直到被 abort；返回观察句柄 */
function hangingDownload(stub: ReturnType<typeof vectorStub>): { started: () => boolean; aborted: () => boolean } {
  let aborted = false;
  let started = false;
  stub.deps.fetchImpl = async (_url, signal) => {
    started = true;
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    return { ok: false, status: 0, body: null };
  };
  return { started: () => started, aborted: () => aborted };
}

test("下载途中收到 setVectorConfig(null)（模型没下完时每轮同步的就是 null）：不取消下载", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const probe = hangingDownload(stub);
  const { core, progress } = vectorCore(dir, stub);
  await core.init(dir);
  core.startModelDownload({
    requestId: "req-keep",
    sources: ["https://down.example/m.gguf"],
    targetPath: join(dir, "vector", "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 10,
  });
  for (let index = 0; index < 20 && !probe.started(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  core.setVectorConfig(null);
  core.setVectorConfig(null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(probe.aborted(), false);
  assert.equal(progress.some((event) => event.phase === "cancelled" || event.phase === "failed"), false);
  core.shutdown();
});

test("cancelModelDownload：取消在途下载，报 cancelled、不报 failed", async () => {
  const dir = await tempDir();
  const stub = vectorStub();
  const probe = hangingDownload(stub);
  const { core, progress } = vectorCore(dir, stub);
  await core.init(dir);
  core.startModelDownload({
    requestId: "req-cancel",
    sources: ["https://down.example/m.gguf"],
    targetPath: join(dir, "vector", "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 10,
  });
  for (let index = 0; index < 20 && !probe.started(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  core.cancelModelDownload();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(probe.aborted(), true);
  assert.equal(progress.at(-1)?.phase, "cancelled");
  assert.equal(progress.some((event) => event.phase === "failed"), false);
});

test("shutdown：同步停掉 llama-server 并取消在途下载；pid 经 onEmbedServerPid 报出", async () => {
  const dir = await tempDir();
  const pids: (number | null)[] = [];
  let kills = 0;
  let downloadAborted = false;
  const core = new MemoryServiceCore({
    callModel: async () => "[]",
    log: () => undefined,
    onEmbedServerPid: (pid) => pids.push(pid),
    vectorDeps: {
      spawn: () => {
        const exitListeners: ((code: number | null) => void)[] = [];
        return {
          pid: 4242,
          on: (_event: "exit", listener: (code: number | null) => void) => exitListeners.push(listener),
          kill: () => {
            kills += 1;
            for (const listener of exitListeners) listener(null);
          },
        };
      },
      probe: async () => true,
      post: async (_port, texts) => texts.map(() => [1, 0, 0, 0]),
      freePort: async () => 1,
      fetchImpl: async (_url, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            downloadAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
        return { ok: false, status: 0, body: null };
      },
    },
  });
  await core.init(dir);
  await core.mutate({ op: "addManual", token: "user", type: "fact", text: "要向量化的一条" });
  core.setVectorConfig({ model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 1_000_000, deferOnBattery: false });
  for (let index = 0; index < 40 && !(await core.vectorState()).llamaRunning; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await core.vectorState()).llamaRunning, true);
  assert.deepEqual(pids, [4242]);
  core.startModelDownload({
    requestId: "req-shutdown",
    sources: ["https://down.example/m.gguf"],
    targetPath: join(dir, "vector", "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  core.shutdown();
  assert.equal(kills, 1);
  assert.equal((await core.vectorState()).llamaRunning, false);
  assert.deepEqual(pids, [4242, null]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(downloadAborted, true);
});

test("补算抛错（向量目录被换成了文件）：接住记日志，不留未捕获 rejection，补算状态复位", async () => {
  const dir = await tempDir();
  const logs: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const stub = vectorStub();
    const core = new MemoryServiceCore({
      callModel: async () => "[]",
      log: (message) => logs.push(message),
      vectorDeps: stub.deps,
    });
    await core.init(dir);
    core.setVectorConfig({ model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 1_000_000, deferOnBattery: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(join(dir, "vector"), { recursive: true, force: true });
    await writeFile(join(dir, "vector"), "不是目录");
    await core.mutate({ op: "addManual", token: "user", type: "fact", text: "触发补算" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(logs.some((line) => line.includes("向量补算失败")), logs.join("\n"));
    assert.deepEqual(unhandled, []);
    assert.equal((await core.vectorState().catch(() => null))?.backfill ?? null, null);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("服务重启（previous 为空）且盘上向量就是这个模型算的：不清库、不重算", async () => {
  const dir = await tempDir();
  const config = { model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true };
  const first = vectorStub();
  const { core } = vectorCore(dir, first);
  await core.init(dir, CHORE);
  await core.mutate({ op: "addManual", token: "user", type: "fact", text: "重启前就算好的条目" });
  core.setVectorConfig(config);
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).vectors?.entries === 1) break;
  }
  assert.equal((await core.vectorState()).vectors?.entries, 1);
  // 新的服务进程：同一个数据目录、同一份配置
  const second = vectorStub();
  const { core: restarted } = vectorCore(dir, second);
  await restarted.init(dir, CHORE);
  restarted.setVectorConfig(config);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(second.embeddedTexts.length, 0);
  assert.equal((await restarted.vectorState()).vectors?.entries, 1);
});

test("服务重启但盘上向量是别的模型算的：manifest 对账照样整库重算", async () => {
  const dir = await tempDir();
  const first = vectorStub();
  const { core } = vectorCore(dir, first);
  await core.init(dir, CHORE);
  await core.mutate({ op: "addManual", token: "user", type: "fact", text: "旧模型算的条目" });
  core.setVectorConfig({ model: VECTOR_MODEL, ggufPath: "/m", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true });
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await core.vectorState()).vectors?.entries === 1) break;
  }
  const second = vectorStub();
  const { core: restarted } = vectorCore(dir, second);
  await restarted.init(dir, CHORE);
  const other = { ...VECTOR_MODEL, id: "qwen3-embedding-0.6b" as const, docPrefix: null };
  restarted.setVectorConfig({ model: other, ggufPath: "/q", binaryPath: "/b", idleUnloadMs: 300_000, deferOnBattery: true });
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (second.embeddedTexts.length > 0 && (await restarted.vectorState()).backfill === null) break;
  }
  assert.ok(second.embeddedTexts.includes("旧模型算的条目"));
  assert.equal((await restarted.vectorState()).vectors?.model, "qwen3-embedding-0.6b");
});

test("服务刚拉起：init 还在读盘时就到的 turnSettled 等 init 完再并入，不被空 store 静默丢掉", async () => {
  const logs: string[] = [];
  const core = new MemoryServiceCore({
    callModel: async () => "same",
    idleCloseMs: 60_000,
    log: (message) => logs.push(message),
  });
  const dir = await tempDir();
  // runtime 的顺序：收到 init 就同步调 core.init（不 await），紧跟着的 turnSettled 立即进来
  const initDone = core.init(dir, CHORE);
  await core.turnSettled(turnPayload());
  await initDone;
  const open = await new EpisodeStore(dir).loadOpen("s1");
  assert.equal(open?.turns.length, 1, `开机第一轮必须进事件段；日志：${logs.join(" | ")}`);
});

test("丢弃留痕：轮号不大于开段 toTurn 的轮被忽略时记一行带会话与轮号的诊断；没收到 init 时同样留痕", async () => {
  const logs: string[] = [];
  const core = new MemoryServiceCore({
    callModel: async () => "same",
    idleCloseMs: 60_000,
    log: (message) => logs.push(message),
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload({ turn: 2 }));
  await core.turnSettled(turnPayload({ turn: 2, at: 1001 })); // 重复投递 / 回退后轮号回落
  const open = await new EpisodeStore(dir).loadOpen("s1");
  assert.equal(open?.turns.length, 1);
  assert.ok(
    logs.some((line) => line.includes("会话 s1 第 2 轮不进事件段") && line.includes("第 2 轮")),
    `应有 ignore 诊断；实际：${logs.join(" | ")}`,
  );

  const noInit = new MemoryServiceCore({ callModel: async () => "same", log: (message) => logs.push(message) });
  await noInit.turnSettled(turnPayload({ sessionId: "s9", turn: 4 }));
  assert.ok(logs.some((line) => line.includes("会话 s9 第 4 轮不进事件段") && line.includes("没收到 init")));
});

/* ---------- 会话回退（sessionReverted） ---------- */

/** 全部层的条目（按 id 索引）：回退测试只关心状态，不关心在哪一层。 */
async function allEntries(dir: string): Promise<Map<string, MemoryEntry>> {
  const store = new MemoryEntryStore(dir);
  const out = new Map<string, MemoryEntry>();
  for (const layer of await store.listLayers()) {
    for (const item of await store.listByToken(layer.token)) out.set(item.text, item);
  }
  return out;
}

test("回退：开段截到回退点、水位回落，重说的那一轮照常并入（不再 ignore）", async () => {
  const logs: string[] = [];
  const core = new MemoryServiceCore({
    callModel: async () => "same",
    idleCloseMs: 60_000,
    log: (message) => logs.push(message),
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload({ turn: 1, at: 1000 }));
  await core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "被撤回的第二轮" }));
  await core.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "被撤回的第三轮" }));
  await core.sessionReverted({ sessionId: "s1", fromTurn: 2 });
  const store = new EpisodeStore(dir);
  const cut = await store.loadOpen("s1");
  assert.deepEqual(cut?.turns.map((turn) => turn.turn), [1]);
  assert.equal(cut?.toTurn, 1);
  await core.turnSettled(turnPayload({ turn: 2, at: 4000, userText: "重说的第二轮" }));
  const open = await store.loadOpen("s1");
  assert.deepEqual(open?.turns.map((turn) => turn.userText), ["我们决定用 QUMem 的分类法", "重说的第二轮"]);
  assert.ok(!logs.some((line) => line.includes("不进事件段")), `不该有 ignore 诊断：${logs.join(" | ")}`);
});

test("回退：待提取段截掉被撤回的轮、截空的整段丢掉；回到第 1 轮后重说的话开新段", async () => {
  const dir = await tempDir();
  // 提取全失败：段一直留在 pending
  const seed = new EpisodeStore(dir);
  await seed.savePending({
    episodeId: "ep_p",
    sessionId: "s1",
    scopeId: "ws-1",
    fromTurn: 1,
    toTurn: 2,
    openedAt: 900,
    lastAt: 2000,
    turns: [
      { turn: 1, at: 1000, userText: "一", assistantText: "答一" },
      { turn: 2, at: 2000, userText: "二", assistantText: "答二" },
    ],
    extracted: { fact: true, preference: false, insight: false },
  });
  const core = new MemoryServiceCore({ callModel: async () => null, idleCloseMs: 60_000, log: () => undefined });
  await core.init(dir, CHORE);
  await core.sessionReverted({ sessionId: "s1", fromTurn: 2 });
  const cut = await seed.loadPending("ep_p");
  assert.deepEqual(cut?.turns.map((turn) => turn.turn), [1]);
  assert.equal(cut?.extracted.fact, true); // 已提成的类不重提
  await core.sessionReverted({ sessionId: "s1", fromTurn: 1 });
  assert.equal(await seed.loadPending("ep_p"), null);
  await core.turnSettled(turnPayload({ turn: 1, at: 5000, userText: "从头再来" }));
  const open = await seed.loadOpen("s1");
  assert.equal(open?.fromTurn, 1);
  assert.equal(open?.turns[0]?.userText, "从头再来");
});

test("回退：被撤回轮提取出的记忆停用（不进召回），部分来源轮的不停用；恢复使用清掉回退标记", async () => {
  const reply = JSON.stringify([
    { text: "第一轮定下的事实：部署用 Docker", keywords: ["Docker"], turns: [1] },
    { text: "第二轮定下的事实：数据库用 Postgres", keywords: ["Postgres"], turns: [2] },
    { text: "两轮合起来的事实：服务跑在 Fly", keywords: ["Fly"], turns: [1, 2] },
  ]);
  let segments = 0;
  const core = new MemoryServiceCore({
    callModel: async (system) => {
      if (system.includes("切分器")) return (segments += 1) === 1 ? "same" : "new";
      return system.includes("事实") ? reply : "[]";
    },
    idleCloseMs: 60_000,
    log: () => undefined,
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload({ turn: 1, at: 1000 }));
  await core.turnSettled(turnPayload({ turn: 2, at: 2000 }));
  await core.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "换个话题" })); // 判新事件：提取 [1, 2]
  assert.equal((await allEntries(dir)).size, 3);
  await core.sessionReverted({ sessionId: "s1", fromTurn: 2 });
  const after = await allEntries(dir);
  const second = after.get("第二轮定下的事实：数据库用 Postgres")!;
  assert.equal(second.status, "muted");
  assert.equal(second.mutedReason, MEMORY_MUTED_REVERTED);
  assert.equal(after.get("第一轮定下的事实：部署用 Docker")?.status, undefined);
  assert.equal(after.get("两轮合起来的事实：服务跑在 Fly")?.status, undefined); // 还有第 1 轮撑着
  assert.equal(await new EpisodeStore(dir).loadOpen("s1"), null); // 第 3 轮的开段整段撤回
  const hits = await core.recall({ sessionId: "s1", scopeId: "ws-1", turn: 2, query: "数据库用什么 Postgres" });
  assert.ok(!hits.some((hit) => hit.entry.id === second.id));
  const token = new MemoryEntryStore(dir).tokenOf("ws-1");
  const outcome = await core.mutate({ op: "setStatus", token, entryId: second.id, status: "active" });
  assert.equal(outcome.ok, true);
  const restored = (await allEntries(dir)).get("第二轮定下的事实：数据库用 Postgres")!;
  assert.equal(restored.status, "active");
  assert.equal(restored.mutedReason, undefined);
  // 对照：恢复后同一个问题召回得到它（上面的「召回不到」不是因为问题本来就不命中）
  const again = await core.recall({ sessionId: "s1", scopeId: "ws-1", turn: 2, query: "数据库用什么 Postgres" });
  assert.ok(again.some((hit) => hit.entry.id === second.id));
});

/** 回退 × 在跑的提取的模型桩：切段按 segments 顺序回；提取调用记下提示词，blockFact 时
 * 第一次事实调用卡在闸上（模拟分钟级的家务活模型），reply 按提示词决定回什么。 */
function revertRaceModel(opts: {
  segments: ("same" | "new")[];
  blockFact?: boolean;
  reply?: (system: string, prompt: string) => string;
}) {
  const extractCalls: { system: string; prompt: string }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let factCalled: () => void = () => undefined;
  const factStarted = new Promise<void>((resolve) => {
    factCalled = resolve;
  });
  let segmentAt = 0;
  let blocked = false;
  const logs: string[] = [];
  const core = new MemoryServiceCore({
    callModel: async (system, prompt) => {
      if (system.includes("切分器")) return opts.segments[segmentAt++] ?? "same";
      extractCalls.push({ system, prompt });
      if (opts.blockFact === true && system.includes("事实") && !blocked) {
        blocked = true;
        factCalled();
        await gate;
      }
      return opts.reply?.(system, prompt) ?? "[]";
    },
    idleCloseMs: 60_000,
    log: (message) => logs.push(message),
  });
  return { core, extractCalls, release: () => release(), factStarted, logs };
}

test("回退在提取调用途中到达：那次输出作废、按截后的轮重提；被撤回轮不进后续提示词、不落盘、不触发第二遍停用", async () => {
  // 模型读到第二轮就写一条「引用第 1 轮」的事实——出处轮号对得上段内，按轮号过滤拦不住它
  const race = revertRaceModel({
    segments: ["same", "new"],
    blockFact: true,
    reply: (system, prompt) =>
      system.includes("事实") && prompt.includes("被撤回的第二轮")
        ? JSON.stringify([{ text: "从被撤回的第二轮里学到的事实", keywords: ["x"], turns: [1] }])
        : "[]",
  });
  const dir = await tempDir();
  await race.core.init(dir, CHORE);
  await race.core.turnSettled(turnPayload({ turn: 1, at: 1000 }));
  await race.core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "被撤回的第二轮" }));
  const settling = race.core.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "换个话题" }));
  await race.factStarted; // 提取卡在事实这一类（提示词里还有第二轮）
  const reverting = race.core.sessionReverted({ sessionId: "s1", fromTurn: 2 });
  race.release();
  await settling;
  await reverting;
  // 卡住的那次 + 重提的事实 + 偏好 + 经验
  assert.equal(race.extractCalls.length, 4);
  assert.ok(race.extractCalls[0]!.prompt.includes("被撤回的第二轮"));
  for (const call of race.extractCalls.slice(1)) {
    assert.ok(!call.prompt.includes("被撤回的第二轮"), `回退之后的提示词不该还有第二轮：${call.system.slice(0, 20)}`);
    assert.ok(call.prompt.includes('<turn n="1"'));
  }
  assert.equal((await allEntries(dir)).size, 0, "作废的那次输出不该落盘");
  assert.ok(!race.logs.some((line) => line.includes("停用")), `不该有停用：${race.logs.join(" | ")}`);
  // 归档的段只剩第 1 轮
  const log = await readFile(join(dir, "episodes", "log.jsonl"), "utf8");
  const archived = JSON.parse(log.trim().split("\n")[0]!) as { turns: { turn: number }[]; toTurn: number };
  assert.deepEqual(archived.turns.map((turn) => turn.turn), [1]);
  assert.equal(archived.toTurn, 1);
});

test("回退在提取开始前到达（切段调用还在跑）：三类提示词都没有被撤回的轮，不多调模型", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let classifying: () => void = () => undefined;
  const classifyStarted = new Promise<void>((resolve) => {
    classifying = resolve;
  });
  let segments = 0;
  const extractCalls: string[] = [];
  const core = new MemoryServiceCore({
    callModel: async (system, prompt) => {
      if (system.includes("切分器")) {
        segments += 1;
        if (segments === 1) return "same";
        classifying();
        await gate;
        return "new";
      }
      extractCalls.push(prompt);
      return "[]";
    },
    idleCloseMs: 60_000,
    log: () => undefined,
  });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload({ turn: 1, at: 1000 }));
  await core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "被撤回的第二轮" }));
  const settling = core.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "换个话题" }));
  await classifyStarted;
  const reverting = core.sessionReverted({ sessionId: "s1", fromTurn: 2 });
  release();
  await settling;
  await reverting;
  assert.equal(extractCalls.length, 3);
  for (const prompt of extractCalls) assert.ok(!prompt.includes("被撤回的第二轮"));
});

test("回退撤回了提取中段的全部轮：不再调模型，段丢掉不归档，不落条目", async () => {
  const race = revertRaceModel({
    segments: ["same", "new"],
    blockFact: true,
    reply: (system) =>
      system.includes("事实") ? JSON.stringify([{ text: "整段撤回前的事实", keywords: ["x"], turns: [1] }]) : "[]",
  });
  const dir = await tempDir();
  await race.core.init(dir, CHORE);
  await race.core.turnSettled(turnPayload({ turn: 1, at: 1000 }));
  await race.core.turnSettled(turnPayload({ turn: 2, at: 2000 }));
  const settling = race.core.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "换个话题" }));
  await race.factStarted;
  const reverting = race.core.sessionReverted({ sessionId: "s1", fromTurn: 1 });
  race.release();
  await settling;
  await reverting;
  assert.equal(race.extractCalls.length, 1); // 只有卡住的那一次
  assert.ok(!race.logs.some((line) => line.includes("失败") || line.includes("出错")), `不该走到出错兜底：${race.logs.join(" | ")}`);
  assert.equal((await allEntries(dir)).size, 0);
  assert.deepEqual(await new EpisodeStore(dir).listPending(), []);
  const archivedLog = await readFile(join(dir, "episodes", "log.jsonl"), "utf8").catch(() => "");
  assert.equal(archivedLog.trim(), "");
});

test("两次回退之间重说的轮：第一次截段之后的提取只按第二次回退截（不被第一次的回退点误截，也不漏截）", async () => {
  // 切段：2 并、3 切（提取 [1,2] 卡住）；回退到 2 后 2' 开新段，3' 并、4' 切（提取 [2',3']）
  const race = revertRaceModel({ segments: ["same", "new", "same", "new"], blockFact: true });
  const dir = await tempDir();
  await race.core.init(dir, CHORE);
  await race.core.turnSettled(turnPayload({ turn: 1, at: 1000 }));
  await race.core.turnSettled(turnPayload({ turn: 2, at: 2000, userText: "旧的第二轮" }));
  const pending: Promise<void>[] = [race.core.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "旧的第三轮" }))];
  await race.factStarted;
  pending.push(race.core.sessionReverted({ sessionId: "s1", fromTurn: 2 }));
  pending.push(race.core.turnSettled(turnPayload({ turn: 2, at: 4000, userText: "重说的第二轮" })));
  pending.push(race.core.turnSettled(turnPayload({ turn: 3, at: 5000, userText: "重说的第三轮" })));
  pending.push(race.core.turnSettled(turnPayload({ turn: 4, at: 6000, userText: "第四轮换话题" })));
  pending.push(race.core.sessionReverted({ sessionId: "s1", fromTurn: 3 }));
  race.release();
  await Promise.all(pending);
  const second = race.extractCalls.filter((call) => call.prompt.includes("重说的第二轮"));
  assert.equal(second.length, 3, "重说的段照常提取三类（没被第一次回退的轮号 2 截空）");
  for (const call of second) assert.ok(!call.prompt.includes("重说的第三轮"), "第二次回退撤回的第 3 轮不该进提示词");
  for (const call of race.extractCalls.slice(1)) {
    assert.ok(!call.prompt.includes("旧的第二轮") && !call.prompt.includes("旧的第三轮"));
  }
});

test("回退在提取调用回来之后、落盘之前到达：落下的被撤回轮条目照样停用（第一遍赶上就第一遍，赶不上靠排队的第二遍兜底）", async () => {
  let revert: () => Promise<void> = async () => undefined;
  let reverting: Promise<void> | null = null;
  let segments = 0;
  const core = new MemoryServiceCore({
    callModel: async (system) => {
      if (system.includes("切分器")) return (segments += 1) === 1 ? "same" : "new";
      if (!system.includes("事实")) return "[]";
      // 调用回来后紧接着的下一拍（提取已过了调用后的检查、正在落盘）到达回退
      setImmediate(() => {
        reverting = revert();
      });
      return JSON.stringify([{ text: "被撤回的第二轮里的事实", keywords: ["x"], turns: [2] }]);
    },
    idleCloseMs: 60_000,
    log: () => undefined,
  });
  revert = () => core.sessionReverted({ sessionId: "s1", fromTurn: 2 });
  const dir = await tempDir();
  await core.init(dir, CHORE);
  await core.turnSettled(turnPayload({ turn: 1, at: 1000 }));
  await core.turnSettled(turnPayload({ turn: 2, at: 2000 }));
  await core.turnSettled(turnPayload({ turn: 3, at: 3000, userText: "换个话题" }));
  assert.ok(reverting !== null);
  await reverting;
  const entry = (await allEntries(dir)).get("被撤回的第二轮里的事实");
  assert.equal(entry?.status, "muted");
  assert.equal(entry?.mutedReason, MEMORY_MUTED_REVERTED);
});
