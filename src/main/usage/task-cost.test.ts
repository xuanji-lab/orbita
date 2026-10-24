import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import {
  estimateTaskCost,
  median,
  officialRates,
  piThinkingTimeline,
  appendTaskRecord,
  emptyTaskBook,
  taskCost,
  taskRecordsOf,
  taskTotals,
  tokenProfile,
  type StoredTask,
  type TaskRecord,
} from "./task-cost.ts";

/** 切段：同一会话的记录逐条喂进账本（去重由调用方做，这里用 seen 模拟回填的全量去重） */
function segmentTasks(records: readonly TaskRecord[], seen: Set<string>, sessionId = "s"): StoredTask[] {
  const book = emptyTaskBook();
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    appendTaskRecord(book, sessionId, record, (ts) => (ts < 1_000 ? "2026-10-23" : "2026-10-24"));
  }
  return book.tasks;
}

/** 一条 assistant 记录：tokens 四项、cost 总价、可选的档章 */
function reply(
  id: string,
  timestamp: number,
  model: string,
  options: { level?: ThinkingLevel; cost?: number; tokens?: [number, number, number, number]; provider?: string } = {},
): SessionRecord {
  const [input, output, cacheRead, cacheWrite] = options.tokens ?? [100, 10, 1000, 0];
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider: options.provider ?? "p", id: model },
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: options.cost ?? 0.01 },
    },
    timestamp,
    status: "complete",
    stopReason: "stop",
    ...(options.level === undefined ? {} : { thinkingLevel: options.level }),
  };
}

const userMsg = (id: string, timestamp: number): SessionRecord => ({
  id,
  role: "user",
  content: [{ type: "text", text: "hi" }],
  timestamp,
});

const piLine = (at: number, level: string) =>
  JSON.stringify({ type: "thinking_level_change", id: "x", parentId: null, timestamp: new Date(at).toISOString(), thinkingLevel: level });

describe("档位：盖章优先，旧记录按 pi 时间线补（能自证没漏才补）", () => {
  test("有字段：用记录上的章，不看时间线", () => {
    const records = [reply("a1", 2000, "m", { level: "max" })];
    const timeline = piThinkingTimeline(piLine(1000, "low"));
    assert.deepEqual(taskRecordsOf(records, timeline, "low").map((r) => r.level), ["max"]);
  });

  test("没字段：pi 时间线最后一档与 meta 对得上 → 按时间线补；读的时候不报错", () => {
    const text = [piLine(1000, "high"), "{坏行", piLine(5000, "off"), piLine(5001, "max")].join("\n");
    const records = [reply("a1", 2000, "m"), reply("a2", 6000, "m")];
    assert.deepEqual(taskRecordsOf(records, piThinkingTimeline(text), "max").map((r) => r.level), ["high", "max"]);
  });

  test("没字段且对不上（中途改过档没记下）：整条没盖章的部分丢弃，不猜", () => {
    const records = [reply("a1", 2000, "m"), reply("a2", 3000, "m")];
    const timeline = piThinkingTimeline(piLine(1000, "low"));
    assert.deepEqual(taskRecordsOf(records, timeline, "xhigh").map((r) => r.level), [undefined, undefined]);
  });

  test("新旧混合：锚点取第一条盖了章的记录，旧记录对得上它就补", () => {
    const records = [reply("a1", 2000, "m"), reply("a2", 3000, "m", { level: "high" }), reply("a3", 4000, "m", { level: "max" })];
    const timeline = piThinkingTimeline(piLine(1000, "high"));
    // meta 已经是 max（后来又切了），但旧记录的锚点是第一条章 high，对得上
    assert.deepEqual(taskRecordsOf(records, timeline, "max").map((r) => r.level), ["high", "high", "max"]);
  });

  test("没有 pi 本子（时间线空）：旧记录不计", () => {
    assert.deepEqual(taskRecordsOf([reply("a1", 2000, "m")], [], "high").map((r) => r.level), [undefined]);
  });
});

describe("切段：同一型号 × 同一档的连续一段", () => {
  const recs = (records: SessionRecord[]): TaskRecord[] => taskRecordsOf(records, [], "high");

  test("用户消息不切段；换档、换型号各切一刀", () => {
    const segments = segmentTasks(
      recs([
        reply("a1", 1, "m", { level: "high" }),
        userMsg("u1", 2),
        reply("a2", 3, "m", { level: "high" }),
        reply("a3", 4, "m", { level: "max" }),
        reply("a4", 5, "n", { level: "max" }),
        reply("a5", 6, "m", { level: "max" }),
      ]),
      new Set(),
    );
    assert.deepEqual(
      segments.map((s) => `${s.modelId}/${s.level}`),
      ["m/high", "m/max", "n/max", "m/max"],
    );
    const first = segments[0];
    assert.ok(first !== undefined);
    assert.equal(taskTotals(first).recordedCost, 0.02);
  });

  test("档不可考的记录记成档 null 的一段：断开前后（两边不拼成一个任务），token 照样在账上", () => {
    const records: TaskRecord[] = [
      ...recs([reply("a1", 1, "m", { level: "high" })]),
      { id: "a2", providerId: "p", modelId: "m", tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, cost: 1, timestamp: 2 },
      ...recs([reply("a3", 3, "m", { level: "high" })]),
    ];
    const segments = segmentTasks(records, new Set());
    assert.deepEqual(segments.map((s) => s.level), ["high", null, "high"]);
    assert.equal(segments[1] === undefined ? -1 : taskTotals(segments[1]).recordedCost, 1);
  });

  test("跨天的一段按本地日期分账，合计不变", () => {
    const [task] = segmentTasks(
      recs([reply("a1", 500, "m", { level: "high", cost: 1 }), reply("a2", 2_000, "m", { level: "high", cost: 2 })]),
      new Set(),
    );
    assert.ok(task !== undefined);
    assert.deepEqual(Object.keys(task.days).sort(), ["2026-10-23", "2026-10-24"]);
    assert.equal(taskTotals(task).recordedCost, 3);
  });

  test("不同会话各切各的，从不拼接（子会话与父会话各算各的）", () => {
    const book = emptyTaskBook();
    const day = () => "2026-10-24";
    for (const r of recs([reply("p1", 1, "m", { level: "high" })])) appendTaskRecord(book, "parent", r, day);
    for (const r of recs([reply("c1", 2, "m", { level: "high" })])) appendTaskRecord(book, "child", r, day);
    for (const r of recs([reply("p2", 3, "m", { level: "high" })])) appendTaskRecord(book, "parent", r, day);
    assert.deepEqual(book.tasks.map((t) => t.sessionId), ["parent", "child"]);
  });

  test("同一条消息 id（分支复制的前缀）只计一次", () => {
    const seen = new Set<string>();
    segmentTasks(recs([reply("a1", 1, "m", { level: "high" })]), seen);
    assert.deepEqual(segmentTasks(recs([reply("a1", 1, "m", { level: "high" }), reply("b1", 2, "m", { level: "high" })]), seen).length, 1);
  });

  test("零价记录（套餐 / 订阅）按官方单价折算；没单价就未知", () => {
    const [segment] = segmentTasks(
      recs([
        reply("a1", 1, "m", { level: "high", cost: 0.5 }),
        reply("a2", 2, "m", { level: "high", cost: 0, tokens: [1_000_000, 0, 0, 0] }),
      ]),
      new Set(),
    );
    assert.ok(segment !== undefined);
    assert.equal(taskCost(taskTotals(segment), { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }), 2.5);
    assert.equal(taskCost(taskTotals(segment), null), null);
  });
});

describe("中位数与估算", () => {
  test("奇数取中间、偶数取中间两个的平均、空为 null", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });

  test("画像：构成按全部任务 token 加权，任务量取中位数", () => {
    const segments = segmentTasks(
      taskRecordsOf(
        [
          reply("a1", 1, "m", { level: "high", tokens: [10, 0, 90, 0] }),
          reply("a2", 2, "n", { level: "high", tokens: [0, 0, 200, 0] }),
          reply("a3", 3, "m", { level: "high", tokens: [0, 0, 300, 0] }),
        ],
        [],
        "high",
      ),
      new Set(),
    );
    const profile = tokenProfile(segments.map(taskTotals));
    assert.equal(profile.reference, false);
    assert.equal(profile.taskCount, 3);
    assert.equal(profile.medianTaskTokens, 200);
    assert.equal(profile.mix.input, 10 / 600);
    assert.equal(profile.mix.cacheRead, 590 / 600);
  });

  test("一个任务都没有：退参考画像（构成和为 1）", () => {
    const profile = tokenProfile([]);
    assert.equal(profile.reference, true);
    assert.ok(profile.medianTaskTokens > 0);
    const sum = profile.mix.input + profile.mix.output + profile.mix.cacheRead + profile.mix.cacheWrite;
    assert.ok(Math.abs(sum - 1) < 1e-12);
  });

  test("估算 = 单价按构成加权 × 任务 token 中位数", () => {
    const profile = { taskCount: 4, medianTaskTokens: 2_000_000, mix: { input: 0.01, output: 0.01, cacheRead: 0.95, cacheWrite: 0.03 }, reference: false };
    const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    // (0.01*3 + 0.01*15 + 0.95*0.3 + 0.03*3.75) / 1e6 * 2e6 = (0.03+0.15+0.285+0.1125)*2 = 1.155
    assert.ok(Math.abs(estimateTaskCost(rates, profile) - 1.155) < 1e-9);
  });
});

describe("官方单价", () => {
  const model = (id: string, cost: [number, number, number, number]) => ({
    id,
    contextWindow: 1,
    maxTokens: 1,
    input: ["text" as const],
    cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: cost[3] },
  });
  const catalog: BuiltinProvider[] = [
    { id: "plan", name: "plan", baseUrl: "", api: "anthropic-messages", models: [model("glm-5.3", [0, 0, 0, 0])] },
    { id: "metered", name: "metered", baseUrl: "", api: "openai-completions", models: [model("glm-5.3", [1.4, 4.4, 0.26, 0])] },
  ];

  test("用户自填的非零费率最优先", () => {
    assert.deepEqual(officialRates(catalog, "glm-5.3", { catalogId: "plan" }, { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 })?.input, 9);
  });

  test("本家目录是套餐零价：往下找全目录里同 id 的非零单价", () => {
    assert.deepEqual(officialRates(catalog, "glm-5.3", { catalogId: "plan" }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0,
    });
  });

  test("哪儿都没有：null", () => {
    assert.equal(officialRates(catalog, "claude-opus-5-5", {}, undefined), null);
  });
});
