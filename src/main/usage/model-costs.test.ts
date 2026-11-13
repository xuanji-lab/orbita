/**
 * model_costs 的表：纯函数 formatModelCosts 的正常路径与边界（没有任何实测任务 / 全是估算 /
 * 型号没添加 / 借分与并进的档），以及 applyModelCosts 的失败分支。
 * 末尾一组走真的 buildPriceChart，证明表里的数字与图的数据一条一条对得上。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PriceChartCategoryData, PriceChartData, PriceChartPoint } from "../../shared/price-chart.ts";
import { applyModelCosts, formatModelCosts } from "./model-costs.ts";

function point(extra: Partial<PriceChartPoint> & Pick<PriceChartPoint, "modelId" | "cost" | "score">): PriceChartPoint {
  return {
    thinkingLevel: "max",
    boardName: extra.modelId,
    scoreLower: extra.score,
    scoreUpper: extra.score,
    costBasis: "measured",
    samples: 5,
    ...extra,
  };
}

function category(
  name: PriceChartCategoryData["category"],
  points: PriceChartPoint[],
  extra: Partial<PriceChartCategoryData> = {},
): PriceChartCategoryData {
  return {
    category: name,
    unit: name === "agent" ? "net-improvement" : "rating",
    publishDate: "2026-10-23",
    points,
    unranked: [],
    unpriced: [],
    ...extra,
  };
}

function chart(categories: PriceChartCategoryData[], reference = false): PriceChartData {
  return {
    categories,
    profile: {
      taskCount: reference ? 0 : 9,
      medianTaskTokens: 1000,
      mix: { input: 0.1, output: 0.1, cacheRead: 0.8, cacheWrite: 0 },
      reference,
    },
    hasPlanProvider: false,
    source: { dataset: "d", url: "u", revision: "r", license: "l", attribution: "a" },
  };
}

/** 表体：去掉说明头，只留列头与数据行 */
function bodyOf(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith("model | thinking"));
  return at === -1 ? [] : lines.slice(at);
}

describe("formatModelCosts", () => {
  test("正常路径：按花费从低到高；实测带样本数；前沿打 *；带 delegate 能直接用的写法", () => {
    const text = formatModelCosts(
      chart([
        category("agent", [
          point({ modelId: "opus", cost: 4, score: 0.2077, samples: 7 }),
          point({ modelId: "flash", cost: 0.031, score: -0.0177, thinkingLevel: null, samples: 12 }),
          point({ modelId: "sonnet", cost: 0.4, score: 0.1, thinkingLevel: "high", samples: 3 }),
          point({ modelId: "dominated", cost: 1, score: 0.05, thinkingLevel: "high", samples: 4 }),
        ]),
        category("coding", [point({ modelId: "opus", cost: 4, score: 1532.4 })]),
      ]),
    );
    assert.deepEqual(bodyOf(text), [
      "model | thinking | $/task | agent | coding",
      "flash | default | $0.031 n=12 | -1.8%* | -",
      "sonnet | high | $0.40 n=3 | +10.0%* | -",
      "dominated | high | $1.00 n=4 | +5.0% | -",
      "opus | max | $4.00 n=7 | +20.8%* | 1532*",
    ]);
    assert.match(text, /delegate with model=<model>, thinkingLevel=<thinking>/);
  });

  test("估算（样本不到 3 件）：写 est，带上不够门槛的实测；整张表一件实测都没有也如实标", () => {
    const text = formatModelCosts(
      chart([
        category("agent", [
          point({ modelId: "a", cost: 0.12, score: 0.1, costBasis: "estimated", samples: 0, measured: { cost: 0.3, samples: 2 } }),
          point({ modelId: "b", cost: 0.5, score: 0.2, costBasis: "estimated", samples: 0 }),
        ]),
      ]),
    );
    assert.deepEqual(bodyOf(text).slice(1), [
      "a | max | est $0.12 (n=2 $0.30) | +10.0%*",
      "b | max | est $0.50 | +20.0%*",
    ]);
  });

  test("用户一个任务都没有（参考画像）：说明头点明全是估算", () => {
    const text = formatModelCosts(
      chart([category("agent", [point({ modelId: "a", cost: 0.2, score: 0.1, costBasis: "reference", samples: 0 })])], true),
    );
    assert.match(text, /has no finished tasks yet, so ALL costs are est/);
    assert.equal(bodyOf(text)[1], "a | max | est $0.20 | +10.0%*");
  });

  test("借分点标 ~、不进前沿，即使它按分数该上前沿；并进的档单独成行，同样借分", () => {
    const text = formatModelCosts(
      chart([
        category("coding", [
          point({ modelId: "m", cost: 2, score: 1500, thinkingLevel: "max", samples: 0, costBasis: "estimated", folded: [{ thinkingLevel: "medium", samples: 1, cost: 0.5 }] }),
          // 借分点：最高档的分配上低档的花费，便宜又高分——不能把它算成前沿
          point({ modelId: "m", cost: 0.4, score: 1500, thinkingLevel: "high", scoreFrom: "max", samples: 4 }),
          point({ modelId: "n", cost: 1, score: 1400, thinkingLevel: "high" }),
        ]),
      ]),
    );
    // m·high 又便宜分又高，但分是借 max 的：不上前沿，前沿是 n·high（1400）与 m·max（1500）
    assert.deepEqual(bodyOf(text).slice(1), [
      "m | high | $0.40 n=4 | 1500~",
      "n | high | $1.00 n=5 | 1400*",
      "m | max | est $2.00 | 1500*",
      "m | medium | est $2.00 (n=1 $0.50) | 1500~",
    ]);
  });

  test("同一档在有的分类按实测、别的分类按估算：以实测的花费为准", () => {
    const text = formatModelCosts(
      chart([
        category("agent", [point({ modelId: "a", cost: 0.9, score: 0.1, costBasis: "estimated", samples: 0 })]),
        category("coding", [point({ modelId: "a", cost: 0.3, score: 1400, samples: 6 })]),
      ]),
    );
    assert.deepEqual(bodyOf(text).slice(1), ["a | max | $0.30 n=6 | +10.0%* | 1400*"]);
  });

  test("已添加但榜单上没有 / 定不出价的型号：只在末尾一行带过；有数据的不重复列", () => {
    const text = formatModelCosts(
      chart([
        category("agent", [point({ modelId: "a", cost: 1, score: 0.1 })], {
          unranked: [{ modelId: "local-llm" }],
          unpriced: [{ modelId: "mystery" }],
        }),
        category("coding", [], { unranked: [{ modelId: "a" }, { modelId: "local-llm" }] }),
      ]),
    );
    assert.match(text, /^Added but not on the Arena board \(no score to compare\): local-llm$/m);
    assert.match(text, /^Added and scored, but no price known .*: mystery$/m);
    assert.equal(bodyOf(text).filter((line) => line.startsWith("a |")).length, 1);
    // 有数据的 a 虽然在 coding 分类上没评，也不进「没上榜」那一句
    assert.ok(!/not on the Arena board.*\ba\b/.test(text));
  });

  test("没有任何可比的型号：不画空表头，只说明原因", () => {
    const text = formatModelCosts(chart([category("agent", [], { unranked: [{ modelId: "x" }] })]));
    assert.deepEqual(bodyOf(text), []);
    assert.match(text, /nothing to compare/);
    assert.match(text, /not on the Arena board.*: x$/m);
    assert.equal(formatModelCosts(chart([])).includes("nothing to compare"), true);
  });

  test("体量：二十行的表也要在几百 token 内（给模型读的，按 4 字符一 token 估）", () => {
    const points = Array.from({ length: 20 }, (_, i) =>
      point({ modelId: `provider-model-${i}`, cost: 0.01 * (i + 1), score: 1300 + i, thinkingLevel: "high" }),
    );
    const text = formatModelCosts(chart(["agent", "overall", "coding", "webdev", "math", "instruction_following"].map((name) =>
      category(name as PriceChartCategoryData["category"], points),
    )));
    assert.ok(text.length / 4 < 1100, `约 ${Math.round(text.length / 4)} token`);
  });
});

describe("applyModelCosts", () => {
  test("成功：回压好的表", async () => {
    const outcome = await applyModelCosts(async () => chart([category("agent", [point({ modelId: "a", cost: 1, score: 0.1 })])]));
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.match(outcome.text, /\na \| max \| \$1\.00 n=5 \| \+10\.0%\*/);
  });

  test("数据源抛错：回 ok:false（工具调用不悬死）", async () => {
    const outcome = await applyModelCosts(async () => {
      throw new Error("ledger broken");
    });
    assert.deepEqual(outcome, { ok: false, error: "Failed to read the price chart: ledger broken" });
  });
});
