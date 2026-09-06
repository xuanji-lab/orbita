/**
 * 用量显示口径的边界（A-1）。这几条规则会被争论，所以钉住：
 * 「不知道」不能显示成 0、定价未知不能显示成免费、缓存全零不进菜单、
 * 速度没见过现场不出行、不足 500ms 的短消息不当真。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentStats } from "@shared/agent-ipc";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import {
  contextRing,
  formatSpeed,
  recordAssistantStart,
  replySpeed,
  streamingStart,
  usageBreakdown,
} from "./stats-format.ts";

const stats = (over: Partial<AgentStats> = {}): AgentStats => ({
  tokens: { input: 18200, output: 4100, cacheRead: 0, cacheWrite: 0, total: 22300 },
  cost: 0.062,
  contextUsage: { tokens: 18200, contextWindow: 200_000, percent: 9 },
  ...over,
});

describe("contextRing —— 不知道就别画", () => {
  test("正常占用给出弧长与人话", () => {
    const ring = contextRing(stats());
    assert.equal(ring.fill, 18200 / 200_000);
    assert.equal(ring.tone, "neutral");
    assert.match(ring.label, /18\.2k \/ 200k · 9%/);
  });

  test("stats 为 null：只画底环，label 说未知", () => {
    const ring = contextRing(null);
    assert.equal(ring.fill, null);
    assert.equal(ring.tone, "neutral");
    assert.match(ring.label, /unknown/);
  });

  test("压缩刚完（tokens 为 null）：只画底环，**不画 0**", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }));
    assert.equal(ring.fill, null);
    assert.match(ring.label, /unknown/);
  });

  test("contextUsage 整个缺席也是未知", () => {
    assert.equal(contextRing(stats({ contextUsage: null })).fill, null);
  });

  test("contextWindow 为 0 不做除法，退回未知", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: 100, contextWindow: 0, percent: null } }));
    assert.equal(ring.fill, null);
  });

  test("过七成 warning、过九成 danger——颜色是第二信号", () => {
    const at = (percent: number) =>
      contextRing(stats({ contextUsage: { tokens: percent * 2000, contextWindow: 200_000, percent } })).tone;
    assert.equal(at(70), "neutral");
    assert.equal(at(71), "warning");
    assert.equal(at(90), "warning");
    assert.equal(at(91), "danger");
  });

  test("占用超窗口也不超过一整圈", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: 400_000, contextWindow: 200_000, percent: 200 } }));
    assert.equal(ring.fill, 1);
    assert.equal(ring.tone, "danger");
  });
});

describe("usageBreakdown —— 菜单里那几行", () => {
  test("没有 stats 就没有行", () => {
    assert.deepEqual(usageBreakdown(null), []);
  });

  test("缓存读写单列，不折进 total——那是「为什么比看起来便宜」的答案", () => {
    assert.deepEqual(
      usageBreakdown(stats()).map((r) => r.label),
      ["Input", "Output", "Cache read", "Cache write", "Total tokens", "Context", "Cost"],
    );
  });

  test("包月制不显示花费——那个数字是估价，跟这个月的账单无关", () => {
    const labels = usageBreakdown(stats(), "plan").map((r) => r.label);
    assert.equal(labels.includes("Cost"), false);
  });

  test("按量计费且真的算得出来才显示花费", () => {
    assert.equal(usageBreakdown(stats(), "metered").at(-1)?.label, "Cost");
  });

  test("没价目表（cost 为 0）就不占那一行——不写 no price list，也不写 unknown", () => {
    const labels = usageBreakdown(stats({ cost: 0 })).map((r) => r.label);
    assert.equal(labels.includes("Cost"), false);
  });

  test("花费四位小数——展开看的人要的正是底栏舍入掉的那几位", () => {
    assert.equal(usageBreakdown(stats({ cost: 0.0625 })).at(-1)?.value, "$0.0625");
  });

  test("压缩刚完：Context 行如实说未知，不写 0", () => {
    const rows = usageBreakdown(
      stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }),
    );
    assert.equal(rows.find((r) => r.label === "Context")?.value, "unknown until next reply");
  });

  test("完全没有上下文数据时连 Context 行都不给", () => {
    const labels = usageBreakdown(stats({ contextUsage: null })).map((r) => r.label);
    assert.equal(labels.includes("Context"), false);
  });
});

// ── token 速度（usage-speed-X）：真值在回答的终态帧上，这里只有展示支援 ──

/** assistant 帧的最小构造；字段按 pi-protocol 的形状，测试只关心记账用得到的那几个 */
const assistantFrame = (over: {
  id: string;
  status: "streaming" | "complete" | "error";
  timestamp: number;
  speed?: number;
}): TranscriptItem =>
  ({
    id: over.id,
    role: "assistant",
    content: [],
    model: { provider: "p", id: "m" },
    timestamp: over.timestamp,
    status: over.status,
    ...(over.speed === undefined ? {} : { speed: over.speed }),
  }) as TranscriptItem;

describe("formatSpeed —— 整数 tok/s", () => {
  test("四舍五入取整", () => {
    assert.equal(formatSpeed(41.6), "42 tok/s");
    assert.equal(formatSpeed(1200.4), "1200 tok/s");
  });
});

describe("recordAssistantStart / streamingStart —— 估算用的起点记账", () => {
  test("streaming 帧记起点，增量帧重复到达不覆盖", () => {
    recordAssistantStart(assistantFrame({ id: "sm1", status: "streaming", timestamp: 1_000 }));
    recordAssistantStart(assistantFrame({ id: "sm1", status: "streaming", timestamp: 2_500 }));
    assert.equal(streamingStart("sm1"), 1_000);
  });

  test("非 streaming 帧、非 assistant 帧不入账；没见过的返回 null", () => {
    recordAssistantStart(assistantFrame({ id: "sm2", status: "complete", timestamp: 9_000 }));
    recordAssistantStart({ id: "t9", role: "tool" } as TranscriptItem);
    assert.equal(streamingStart("sm2"), null);
    assert.equal(streamingStart("never-seen"), null);
  });
});

describe("replySpeed —— 回答上的速度标注", () => {
  test("读 adapter 挂在终态帧上的 speed", () => {
    assert.equal(replySpeed(assistantFrame({ id: "a1", status: "complete", timestamp: 0, speed: 42 })), 42);
  });

  test("没挂 speed（噪音门没过 / 旧会话）、坏值、非 assistant 记录，一律 null", () => {
    assert.equal(replySpeed(assistantFrame({ id: "a2", status: "complete", timestamp: 0 })), null);
    assert.equal(replySpeed(assistantFrame({ id: "a3", status: "complete", timestamp: 0, speed: -1 })), null);
    assert.equal(replySpeed({ id: "c1", role: "compacted" } as unknown as TranscriptItem), null);
    assert.equal(replySpeed(undefined), null);
  });
});
