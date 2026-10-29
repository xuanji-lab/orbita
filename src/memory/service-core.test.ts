/**
 * 记忆服务核心（service-core.ts）——turnSettled 的切段与提取编排、recall 的两层
 * 合并与注入账本、没配模型的静默、启动清扫（闲置追认 / 半路提取续跑）。
 * 纯模块直测（node --test）：模型调用与时间注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryServiceCore, type MemoryCallModel } from "./service-core.ts";
import { EpisodeStore } from "./episodes.ts";
import { MemoryEntryStore } from "./entries.ts";
import type { MemoryChoreModel } from "../shared/memory.ts";

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
  await new Promise((resolve) => setTimeout(resolve, 60)); // idleCloseMs = 25
  await new Promise((resolve) => setTimeout(resolve, 10));
  const store = new EpisodeStore(dir);
  assert.equal(await store.loadOpen("s1"), null); // 收尾提完了
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
