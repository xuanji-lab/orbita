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
  ringLayers,
  NESTED_RING_LIMIT,
  WRAP_UP_AFTER_COMPACTIONS,
  streamingStart,
  usageBreakdown,
} from "./stats-format.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

const stats = (over: Partial<AgentStats> = {}): AgentStats => ({
  tokens: { input: 18200, output: 4100, cacheRead: 0, cacheWrite: 0, total: 22300 },
  cost: 0.062,
  contextUsage: { tokens: 18200, contextWindow: 200_000, percent: 9 },
  ...over,
});

describe("contextRing —— 不知道就别画", () => {
  test("正常占用给出弧长与人话", () => {
    const ring = contextRing(stats(), en);
    assert.equal(ring.fill, 18200 / 200_000);
    assert.equal(ring.tone, "neutral");
    assert.match(ring.label, /18\.2k \/ 200k · 9%/);
  });

  test("stats 为 null：只画底环，label 说未知", () => {
    const ring = contextRing(null, en);
    assert.equal(ring.fill, null);
    assert.equal(ring.tone, "neutral");
    assert.match(ring.label, /unknown/);
  });

  test("压缩刚完（tokens 为 null）：只画底环，**不画 0**", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }), en);
    assert.equal(ring.fill, null);
    assert.match(ring.label, /unknown/);
  });

  test("contextUsage 整个缺席也是未知", () => {
    assert.equal(contextRing(stats({ contextUsage: null }), en).fill, null);
  });

  test("contextWindow 为 0 不做除法，退回未知", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: 100, contextWindow: 0, percent: null } }), en);
    assert.equal(ring.fill, null);
  });

  test("过七成 warning、过九成 danger——颜色是第二信号", () => {
    const at = (percent: number) =>
      contextRing(stats({ contextUsage: { tokens: percent * 2000, contextWindow: 200_000, percent } }), en).tone;
    assert.equal(at(70), "neutral");
    assert.equal(at(71), "warning");
    assert.equal(at(90), "warning");
    assert.equal(at(91), "danger");
  });

  test("占用超窗口也不超过一整圈", () => {
    const ring = contextRing(stats({ contextUsage: { tokens: 400_000, contextWindow: 200_000, percent: 200 } }), en);
    assert.equal(ring.fill, 1);
    assert.equal(ring.tone, "danger");
  });
});

describe("usageBreakdown —— 菜单里那几行", () => {
  test("没有 stats 就没有行", () => {
    assert.deepEqual(usageBreakdown(null, en), []);
  });

  test("缓存读写单列，不折进 total——那是「为什么比看起来便宜」的答案", () => {
    assert.deepEqual(
      usageBreakdown(stats(), en).map((r) => r.label),
      ["Input", "Output", "Cache read", "Cache write", "Total tokens", "Context", "Cost"],
    );
  });

  test("包月制不显示花费——那个数字是估价，跟这个月的账单无关", () => {
    const labels = usageBreakdown(stats(), en, "plan").map((r) => r.label);
    assert.equal(labels.includes("Cost"), false);
  });

  test("按量计费且真的算得出来才显示花费", () => {
    assert.equal(usageBreakdown(stats(), en, "metered").at(-1)?.label, "Cost");
  });

  test("没价目表（cost 为 0）就不占那一行——不写 no price list，也不写 unknown", () => {
    const labels = usageBreakdown(stats({ cost: 0 }), en).map((r) => r.label);
    assert.equal(labels.includes("Cost"), false);
  });

  test("花费四位小数——展开看的人要的正是底栏舍入掉的那几位", () => {
    assert.equal(usageBreakdown(stats({ cost: 0.0625 }), en).at(-1)?.value, "$0.0625");
  });

  test("压缩刚完：Context 行如实说未知，不写 0", () => {
    const rows = usageBreakdown(
      stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }), en,
    );
    assert.equal(rows.find((r) => r.label === "Context")?.value, "unknown until next reply");
  });

  test("完全没有上下文数据时连 Context 行都不给", () => {
    const labels = usageBreakdown(stats({ contextUsage: null }), en).map((r) => r.label);
    assert.equal(labels.includes("Context"), false);
  });
});

// ── token 速度（usage-speed-X）：真值在回答的终态帧上，这里只有展示支援 ──

/** assistant 帧的最小构造；字段按 pi-protocol 的形状，测试只关心记账用得到的那几个 */
const assistantFrame = (over: {
  id: string;
  status: "streaming" | "complete" | "error";
  timestamp: number;
  genMs?: number;
  output?: number;
}): TranscriptItem =>
  ({
    id: over.id,
    role: "assistant",
    content: [],
    model: { provider: "p", id: "m" },
    timestamp: over.timestamp,
    status: over.status,
    ...(over.output === undefined
      ? {}
      : { usage: { input: 0, output: over.output, cacheRead: 0, cacheWrite: 0, totalTokens: over.output, cost: {} } }),
    ...(over.genMs === undefined ? {} : { genMs: over.genMs }),
  }) as TranscriptItem;

describe("formatSpeed —— 整数 tok/s", () => {
  test("四舍五入取整", () => {
    assert.equal(formatSpeed(41.6, en), "42 tok/s");
    assert.equal(formatSpeed(1200.4, en), "1200 tok/s");
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

describe("replySpeed —— 回答上的速度标注，按整轮加总", () => {
  test("单条：usage.output ÷ genMs", () => {
    assert.equal(
      replySpeed([assistantFrame({ id: "a1", status: "complete", timestamp: 0, genMs: 2_000, output: 84 })]),
      42,
    );
  });

  test("多条：各自不过门的短尾巴加在一起过门——验收复现的那种「说一句→跑工具→再说一句」", () => {
    const turn = [
      assistantFrame({ id: "a1", status: "complete", timestamp: 0, genMs: 822, output: 67 }),
      assistantFrame({ id: "a2", status: "complete", timestamp: 1, genMs: 300, output: 21 }),
    ];
    assert.equal(replySpeed([turn[1] as TranscriptItem]), null); // 末条单算：300ms 过不了门
    assert.equal(replySpeed(turn), 88 / 1.122); // 整轮：(67+21) / (822+300)ms
  });

  test("没挂 genMs（旧会话）、缺 usage、非 assistant，都不计；全部不计就 null", () => {
    assert.equal(replySpeed([assistantFrame({ id: "a2", status: "complete", timestamp: 0, output: 500 })]), null);
    assert.equal(replySpeed([assistantFrame({ id: "a3", status: "complete", timestamp: 0, genMs: 2_000 })]), null);
    assert.equal(replySpeed([{ id: "c1", role: "compacted" } as unknown as TranscriptItem]), null);
    assert.equal(replySpeed([]), null);
    // 混着一条旧记录：只算挂了的那条
    assert.equal(
      replySpeed([
        assistantFrame({ id: "a4", status: "complete", timestamp: 0, output: 9_999 }),
        assistantFrame({ id: "a5", status: "complete", timestamp: 1, genMs: 1_000, output: 50 }),
      ]),
      50,
    );
  });
});

describe("usageBreakdown / formatSpeed —— 中文（小学作业）", () => {
  test("分项名说中文，数字写法不变", () => {
    assert.deepEqual(
      usageBreakdown(stats({ cost: 0 }), zh).map((r) => r.label),
      ["输入", "输出", "缓存读取", "缓存写入", "合计", "上下文"],
    );
    assert.equal(formatSpeed(41.6, zh), "42 tok/s");
  });
});

describe("ringLayers —— 一圈一个上下文窗口，塞不下就写数字", () => {
  test("没压缩过：只有最外圈，中间空", () => {
    assert.deepEqual(ringLayers(0), { full: 0, label: null });
  });

  test("压缩 1 次：外圈画满，当前用量在里圈，不写数字", () => {
    assert.deepEqual(ringLayers(1), { full: 1, label: null });
  });

  test("压缩 2 次起：内圈收掉，中间写第几个窗口（次数 + 1），两位数照写", () => {
    assert.equal(NESTED_RING_LIMIT, 2);
    assert.deepEqual(ringLayers(2), { full: 0, label: "3" });
    assert.deepEqual(ringLayers(3), { full: 0, label: "4" });
    assert.deepEqual(ringLayers(11), { full: 0, label: "12" });
  });

  test("脏输入不画出负圈或小数圈", () => {
    assert.deepEqual(ringLayers(-1), { full: 0, label: null });
    assert.deepEqual(ringLayers(1.7), { full: 1, label: null });
  });

  test("建议收尾的门槛在第三次压缩之前", () => {
    assert.equal(WRAP_UP_AFTER_COMPACTIONS, 2);
  });
});

describe("压缩次数文案", () => {
  test("中英都有，英文单复数分开", () => {
    assert.equal(zh.stats.compactedTimes(3), "3 次");
    assert.equal(en.stats.compactedTimes(1), "1 time");
    assert.equal(en.stats.compactedTimes(2), "2 times");
  });
});
