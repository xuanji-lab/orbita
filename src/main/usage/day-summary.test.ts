import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { Provider } from "../../shared/provider.ts";
import type { IntentRecallRecord, SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { localDateKey } from "../../shared/usage.ts";
import { usageCountsOfIntent } from "../../shared/intent-recall.ts";
import { boardIndexOf } from "./arena-board.ts";
import { usageDays } from "./day-summary.ts";
import { modelGroups } from "./model-groups.ts";
import { TaskLedger } from "./task-ledger.ts";
import { taskRecordOf } from "./task-cost.ts";
import { isEmptyErrorAssistant } from "../session/store.ts";

const TZ = "Asia/Singapore";
const D1 = Date.UTC(2026, 9, 20, 15, 50); // 2026-10-20 23:50 SGT
const D2 = Date.UTC(2026, 9, 20, 16, 10); // 2026-10-21 00:10 SGT（跨午夜）
const D3 = Date.UTC(2026, 9, 22, 4);

function reply(
  id: string,
  timestamp: number,
  model: string,
  provider: string,
  tokens: [number, number, number, number],
  cost: number,
  level?: ThinkingLevel,
): SessionRecord {
  const [input, output, cacheRead, cacheWrite] = tokens;
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider, id: model },
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    timestamp,
    status: "complete",
    stopReason: "stop",
    ...(level === undefined ? {} : { thinkingLevel: level }),
  };
}

function intent(id: string, timestamp: number, promptTokens: number, completionTokens: number, cachedTokens: number): IntentRecallRecord {
  return {
    role: "intent-recall",
    id,
    turnId: "t",
    status: "done",
    runId: null,
    timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    scene: null,
    qaTotal: null,
    passed: null,
    budgetMs: null,
    peak: false,
    timings: null,
    summary: null,
    selected: [],
    ask: [],
    error: null,
    skipped: null,
    gateWhy: null,
    halted: null,
    usage: { promptTokens, completionTokens, cachedTokens },
  };
}

function meta(id: string, createdAt: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: "",
    titleSource: "derived",
    stats: null,
    cwd: "/",
    workspaceId: null,
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    providerId: "p",
    modelId: "m",
    mode: "plan",
    thinkingLevel: "high",
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

/**
 * 改账本之前的日账本（src/main/usage/ledger.ts，本 PR 删除；原文见 git show 91b18428:src/main/usage/ledger.ts）
 * 回填的算法，逐条照抄：跳过导入会话；按 list() 的顺序逐会话读原始日志；assistant 记录带 usage、
 * 不是空 error 回答，或 intent-recall 记录带 usage，就按记录 id 去重、四项相加、按本地日期累加，
 * 四项和为 0 的不计。
 */
function oldDailyTotals(logs: Record<string, SessionRecord[]>, metas: SessionMeta[]): Map<string, number> {
  const days = new Map<string, number>();
  const seen = new Set<string>();
  for (const m of metas) {
    if (m.importedFrom !== undefined) continue;
    for (const record of logs[m.id] ?? []) {
      let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
      if (record.role === "assistant" && record.usage !== undefined && !isEmptyErrorAssistant(record)) usage = record.usage;
      if (record.role === "intent-recall" && record.usage !== undefined) usage = usageCountsOfIntent(record.usage);
      if (usage === null || seen.has(record.id)) continue;
      const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (total <= 0) continue;
      seen.add(record.id);
      const date = localDateKey(record.timestamp, TZ);
      days.set(date, (days.get(date) ?? 0) + total);
    }
  }
  return days;
}

const logs: Record<string, SessionRecord[]> = {
  a: [
    reply("a1", D1, "glm-5.3", "zhipu-coding", [100, 10, 1000, 0], 0, "max"),
    reply("a2", D2, "glm-5.3", "zhipu-coding", [50, 5, 500, 0], 0, "max"),
    intent("i1", D2, 300, 40, 100),
    reply("a3", D3, "k3", "kimi-coding", [10, 1, 100, 20], 0.5, "high"),
  ],
  // 别名：kimi-k3 与 k3 是一个型号；没盖章的旧记录（档不可考）照样计 token
  b: [reply("b1", D3, "kimi-k3", "anthropic-compatible", [5, 5, 50, 0], 0.2)],
  // 分支：复制了 a 的前缀
  branch: [reply("a1", D1, "glm-5.3", "zhipu-coding", [100, 10, 1000, 0], 0, "max"), reply("c1", D3, "glm-5.3", "zhipu-coding", [1, 1, 1, 1], 0, "high")],
  // 空 error 回答（auto_retry 的失败尝试）不计
  err: [
    {
      id: "e1",
      role: "assistant",
      content: [],
      model: { provider: "zhipu-coding", id: "glm-5.3" },
      usage: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, totalTokens: 36, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: D1,
      status: "error",
      stopReason: "error",
    },
  ],
  imported: [reply("z1", D1, "glm-5.3", "zhipu-coding", [999, 999, 999, 999], 9)],
};
const metas = [meta("a", 1), meta("b", 2), meta("branch", 3), meta("err", 4), meta("imported", 5, { importedFrom: "/x.jsonl" })];
const dates = ["2026-10-20", "2026-10-21", "2026-10-22"];

const providers: Provider[] = [
  {
    id: "zhipu-coding",
    kind: "zhipu-coding",
    displayName: "智谱 Coding Plan",
    endpoint: { baseUrl: "https://x", api: "anthropic-messages" },
    auth: { scheme: "none" },
    models: { declared: [{ id: "glm-5.3", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }] },
  },
  {
    id: "kimi-coding",
    kind: "kimi-coding",
    displayName: "Kimi",
    endpoint: { baseUrl: "https://x", api: "anthropic-messages" },
    auth: { scheme: "none" },
    models: { declared: [{ id: "k3" }] },
  },
];
const catalog: BuiltinProvider[] = [];
const index = boardIndexOf([[["Kimi K3 (Max)", 0.01, 0, 0.02, 1, 1], ["GLM-5.3 (Max)", 0.01, 0, 0.02, 1, 2]]]);

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-day-summary-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const source = { list: async () => metas, readRawLog: async (id: string) => logs[id] ?? [], readPiFile: async () => null };

describe("用量格：新账本按「天 × 型号」汇总", () => {
  test("同一份会话数据，新旧两种算法得出的每天合计相等（回填与增量两条路径都相等）", async () => {
    const old = oldDailyTotals(logs, metas);
    assert.deepEqual(Object.fromEntries(old), { "2026-10-20": 1110, "2026-10-21": 895, "2026-10-22": 195 });

    const full = new TaskLedger(join(dir, "full.json"), { timeZone: TZ });
    await full.load();
    await full.backfill(source);
    const viaBackfill = usageDays({ dates, tasks: full.tasks(), intent: full.intentByDay(), models: modelGroups(providers, catalog, index) });
    for (const day of viaBackfill) assert.equal(day.tokens, old.get(day.date) ?? 0, day.date);

    // 增量：与 recorder 落盘同样逐条喂（只喂会真的落盘的：空 error 回答 recorder 不收，导入会话的旧记录不重放）
    const live = new TaskLedger(join(dir, "live.json"), { timeZone: TZ });
    await live.load();
    await live.backfill({ list: async () => [], readRawLog: async () => [], readPiFile: async () => null });
    for (const m of metas.filter((x) => x.importedFrom === undefined)) {
      for (const record of logs[m.id] ?? []) {
        if (record.role === "intent-recall" && record.usage !== undefined) {
          await live.recordIntent({ id: record.id, timestamp: record.timestamp, tokens: usageCountsOfIntent(record.usage) });
        }
        if (record.role !== "assistant" || isEmptyErrorAssistant(record)) continue;
        const item = taskRecordOf(record, "thinkingLevel" in record ? record.thinkingLevel : undefined);
        if (item !== null) await live.record(m.id, item);
      }
    }
    const viaLive = usageDays({ dates, tasks: live.tasks(), intent: live.intentByDay(), models: modelGroups(providers, catalog, index) });
    assert.deepEqual(viaLive.map((d) => d.tokens), viaBackfill.map((d) => d.tokens));
  });

  test("按型号分布：别名合成一行、token 多的在前；意图召回单列", async () => {
    const ledger = new TaskLedger(join(dir, "t.json"), { timeZone: TZ });
    await ledger.load();
    await ledger.backfill(source);
    const [, d21, d22] = usageDays({ dates, tasks: ledger.tasks(), intent: ledger.intentByDay(), models: modelGroups(providers, catalog, index) });
    assert.deepEqual(d21?.models.map((m) => [m.modelId, m.tokens]), [["glm-5.3", 555]]);
    assert.equal(d21?.intentTokens, 340);
    // 10-22：k3（Kimi Code）131 + kimi-k3（Anthropic 兼容）60 合成一行 Kimi K3；glm 4
    assert.deepEqual(d22?.models.map((m) => [m.modelId, m.tokens]), [["k3", 191], ["glm-5.3", 4]]);
    assert.deepEqual(d22?.models[0]?.vendor, { kindId: "kimi-coding", label: "Kimi" });
  });

  test("折算花费：自带的照用，零价按官方单价折算；缺单价或有意图召回标 partial；没用量为 null", async () => {
    const ledger = new TaskLedger(join(dir, "t.json"), { timeZone: TZ });
    await ledger.load();
    await ledger.backfill(source);
    const [d20, d21, d22] = usageDays({
      dates,
      tasks: ledger.tasks(),
      intent: ledger.intentByDay(),
      models: modelGroups(providers, catalog, index),
    });
    // 10-20：glm 零价 1110 token × $1/M（用户自填）
    assert.ok(Math.abs((d20?.cost?.usd ?? 0) - 1110 / 1e6) < 1e-12);
    assert.equal(d20?.cost?.partial, false);
    // 10-21：有意图召回（没有单价）→ partial
    assert.equal(d21?.cost?.partial, true);
    // 10-22：k3 自带 $0.5 + kimi-k3 自带 $0.2 + glm 零价 4 token × $1/M
    assert.ok(Math.abs((d22?.cost?.usd ?? 0) - (0.7 + 4 / 1e6)) < 1e-12);
    const empty = usageDays({ dates: ["2026-10-01"], tasks: ledger.tasks(), intent: ledger.intentByDay(), models: modelGroups(providers, catalog, index) });
    assert.equal(empty[0]?.cost, null);
    assert.equal(empty[0]?.tokens, 0);
  });
});
