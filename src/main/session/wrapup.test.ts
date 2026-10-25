import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { buildClosingScanPrompt } from "../../shared/wrapup-scan.ts";
import { confirmedThrough, wrapupOf, wrapupPlanOf } from "./wrapup.ts";

const user = (id: string, text = "做点事"): SessionRecord => ({ id, role: "user", content: [{ type: "text", text }], timestamp: 0 });

function reply(id: string, model: string, level: ThinkingLevel, tokens: number, cost: number): SessionRecord {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider: "p", id: model },
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    timestamp: 0,
    status: "complete",
    stopReason: "stop",
    thinkingLevel: level,
  } as SessionRecord;
}

const rates = (modelId: string) => (modelId === "plan" ? { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } : null);

const records: SessionRecord[] = [
  user("u1"),
  reply("a1", "opus", "high", 1000, 0.5),
  reply("a1", "opus", "high", 1000, 0.5), // 流式重放的重复行：只计一次
  user("u2"),
  reply("a2", "plan", "medium", 500_000, 0), // 套餐：零价，按官方价折算 $1
  user("scan", buildClosingScanPrompt({ sinceTurn: 1, lastTurn: 2, turns: [] })),
  reply("a3", "flash", "high", 9999, 0.01), // 扫描轮：不属于任何一轮
  user("u3"),
  reply("a4", "opus", "high", 10, 0.01),
];

describe("wrapupPlanOf", () => {
  test("各轮用量按「服务商 × 型号 × 档」分组；机器提问那一轮不进任何一轮；零价按官方价折算", () => {
    const plan = wrapupPlanOf({ records, meta: { thinkingLevel: "medium" }, timeline: [], rates });
    assert.ok(plan !== null);
    assert.equal(plan.sinceTurn, 1);
    assert.equal(plan.lastTurn, 3);
    assert.deepEqual(
      plan.turns.map((t) => [t.n, t.userId, t.usage.map((u) => [u.modelId, u.level, u.tokens.input, u.officialCost])]),
      [
        [1, "u1", [["opus", "high", 1000, 0.5]]],
        [2, "u2", [["plan", "medium", 500_000, 1]]],
        [3, "u3", [["opus", "high", 10, 0.01]]],
      ],
    );
  });

  test("会话重开后再收尾：只看上次确认之后的轮；没有新轮次 → null", () => {
    const wrapup = { id: "w", at: 0, throughTurn: 2, items: [] };
    const plan = wrapupPlanOf({ records, meta: { thinkingLevel: "medium", wrapups: [wrapup] }, timeline: [], rates });
    assert.deepEqual(plan?.turns.map((t) => t.n), [3]);
    assert.equal(plan?.sinceTurn, 3);
    assert.equal(
      wrapupPlanOf({ records, meta: { thinkingLevel: "medium", wrapups: [{ ...wrapup, throughTurn: 3 }] }, timeline: [], rates }),
      null,
    );
    assert.equal(confirmedThrough({ wrapups: [wrapup, { ...wrapup, throughTurn: 1 }] }), 2);
  });
});

describe("wrapupOf（确认后的落账快照）", () => {
  test("每件做完的事带那几轮的合计与 token 最多的型号 × 档；空标题丢掉；throughTurn 夹在计划范围内", () => {
    const plan = wrapupPlanOf({ records, meta: { thinkingLevel: "medium" }, timeline: [], rates });
    assert.ok(plan !== null);
    const wrapup = wrapupOf(
      plan,
      {
        throughTurn: 99,
        done: [
          { title: " 修好登录 ", turns: [1, 2] },
          { title: "", turns: [3, 3] },
          { title: "自己加的", turns: null },
        ],
        carryovers: [],
      },
      123,
    );
    assert.equal(wrapup.at, 123);
    assert.equal(wrapup.throughTurn, 3);
    assert.equal(wrapup.items.length, 2);
    const [first, own] = wrapup.items;
    assert.deepEqual(
      [first?.title, first?.modelId, first?.level, first?.tokens.input, first?.recordedCost, first?.unpricedTokens.input],
      ["修好登录", "plan", "medium", 501_000, 0.5, 500_000],
    );
    assert.deepEqual([own?.title, own?.modelId, own?.tokens.input], ["自己加的", null, 0]);
  });
});
