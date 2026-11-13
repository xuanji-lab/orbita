/**
 * agent 的 model_costs 工具的落点：把「价格 · 能力图」的数据压成一张给**模型**读的紧凑表，
 * 让主会话派子会话前能按「够用且最便宜」选型号 × 思考档（用户 2026-10-30：「我们的帕累托数据，
 * 我希望能作为主会话派发子会话前的参考数据」）。**纯模块**（不 import electron）。
 *
 * 数据只来自 PriceChartData（与设置页同一份，见 price-chart-source.ts），这里不算花费、不算分数；
 * 前沿用 shared 的 paretoFrontier（与图同一实现，借分点同样不进前沿）。
 *
 * 一行 = 型号 × 思考档，只含用户已添加、榜单评过且定得出价的型号（图里能画出来的）。
 * 不带服务商：图的契约就是「型号 × 档」合并各服务商（delegate 的 model 参数也只收裸型号 id，
 * 主进程按「同父服务商优先、否则第一个声明了它的」解析），服务商对派发不构成选择。
 *
 * 输出要短（几百 token）——它进模型上下文。
 */
import type { ModelCostsOutcome } from "../../shared/agent-ipc.ts";
import {
  paretoFrontier,
  pointKey,
  type PriceChartCategory,
  type PriceChartCategoryData,
  type PriceChartData,
  type PriceChartPoint,
  type PriceChartScoreUnit,
} from "../../shared/price-chart.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";

/** 列头：给模型看的短名，顺序跟 PriceChartData.categories（= 设置页的分类顺序） */
const CATEGORY_HEADERS: Record<PriceChartCategory, string> = {
  agent: "agent",
  overall: "overall",
  coding: "coding",
  webdev: "webdev",
  math: "math",
  instruction_following: "instr",
};

interface ScoreCell {
  text: string;
  /** 在这个分类的帕累托前沿上 */
  frontier: boolean;
  /** 分是借同型号榜单评过的最高档的 */
  borrowed: boolean;
}

interface CostCell {
  cost: number;
  measured: boolean;
  /** measured: 实测任务数；估算: 不够门槛的实测任务数（0 = 一个都没有） */
  samples: number;
  /** 估算行上不够门槛的那些实测任务的中位数 */
  measuredCost: number | null;
}

interface Row {
  modelId: string;
  level: ThinkingLevel | null;
  cost: CostCell;
  scores: Map<PriceChartCategory, ScoreCell>;
}

/** 分数：Bradley-Terry 取整；net improvement 显示成带符号的百分比（同设置页 formatScore） */
function scoreText(score: number, unit: PriceChartScoreUnit): string {
  if (unit === "rating") return String(Math.round(score));
  const pct = score * 100;
  return `${pct > 0 ? "+" : pct < 0 ? "-" : ""}${Math.abs(pct).toFixed(1)}%`;
}

/** 花费：≥ 1 两位小数，< 1 两位有效数字 */
function costText(amount: number): string {
  return amount >= 1 ? `$${amount.toFixed(2)}` : `$${amount.toPrecision(2)}`;
}

function costCellOf(point: PriceChartPoint, folded?: { samples: number; cost: number }): CostCell {
  if (folded !== undefined) {
    return { cost: point.cost, measured: false, samples: folded.samples, measuredCost: folded.cost };
  }
  return point.costBasis === "measured"
    ? { cost: point.cost, measured: true, samples: point.samples, measuredCost: null }
    : { cost: point.cost, measured: false, samples: point.measured?.samples ?? 0, measuredCost: point.measured?.cost ?? null };
}

function costCellText(cell: CostCell): string {
  if (cell.measured) return `${costText(cell.cost)} n=${cell.samples}`;
  const tried = cell.measuredCost === null ? "" : ` (n=${cell.samples} ${costText(cell.measuredCost)})`;
  return `est ${costText(cell.cost)}${tried}`;
}

/** 给模型的说明头：每个符号只讲一次，别的不赘述 */
function headerLines(data: PriceChartData): string[] {
  const lines = [
    "Added models x thinking tier, cheapest first. $/task: n=<k> = median cost of the user's own k finished tasks; " +
      "est = fewer than 3 such tasks (or none), priced from list price x the user's usual token mix" +
      (data.profile.reference ? " (the user has no finished tasks yet, so ALL costs are est from a built-in reference profile)" : "") +
      " - a rough guide. (n=k $x) = what those k real tasks actually cost; if it is far from est, trust it more.",
    "Scores are Arena leaderboard scores per category (higher = better): * = on that category's Pareto frontier " +
      "(no cheaper tier scores as high); ~ = borrowed from the model's top rated tier (the board did not rate this tier), never on the frontier; - = not rated.",
    "delegate with model=<model>, thinkingLevel=<thinking> (default = leave thinkingLevel out).",
  ];
  return lines;
}

/** 把价格 · 能力图的数据压成给模型读的文本表 */
export function formatModelCosts(data: PriceChartData): string {
  const categories = data.categories;
  // 每个分类的前沿（借分点不进，同设置页）
  const frontiers = new Map<PriceChartCategory, Set<string>>(
    categories.map((c) => [c.category, new Set(paretoFrontier(c.points.filter((p) => p.scoreFrom === undefined)).map(pointKey))]),
  );
  const rows = new Map<string, Row>();
  const touch = (modelId: string, level: ThinkingLevel | null, cost: CostCell): Row => {
    const key = pointKey({ modelId, thinkingLevel: level });
    let row = rows.get(key);
    if (row === undefined) {
      row = { modelId, level, cost, scores: new Map() };
      rows.set(key, row);
    } else if (cost.measured && !row.cost.measured) {
      row.cost = cost; // 有的分类上这一档按实测、别的分类按估算：以实测为准
    }
    return row;
  };
  for (const category of categories) {
    const own = new Set(category.points.map(pointKey));
    for (const point of category.points) {
      const row = touch(point.modelId, point.thinkingLevel, costCellOf(point));
      row.scores.set(category.category, {
        text: scoreText(point.score, category.unit),
        frontier: frontiers.get(category.category)?.has(pointKey(point)) === true,
        borrowed: point.scoreFrom !== undefined,
      });
      // 并进这个点的、榜单没评的档：借的是这一点的分，估算与档无关（契约 PriceChartPoint.folded）
      for (const folded of point.folded ?? []) {
        if (own.has(pointKey({ modelId: point.modelId, thinkingLevel: folded.thinkingLevel }))) continue;
        touch(point.modelId, folded.thinkingLevel, costCellOf(point, folded)).scores.set(category.category, {
          text: scoreText(point.score, category.unit),
          frontier: false,
          borrowed: true,
        });
      }
    }
  }

  // 已添加、但一个分类都画不出来的型号：分两句带过（榜单没评 / 评了但定不出价），免得模型以为没添加。
  // 定不出价的是用户可以去设置里填费率补上的，值得点明
  const drawn = new Set([...rows.values()].map((row) => row.modelId));
  const listed = (pick: (c: PriceChartCategoryData) => readonly { modelId: string }[]): string[] => [
    ...new Set(categories.flatMap((c) => pick(c).map((ref) => ref.modelId))),
  ].filter((id) => !drawn.has(id));
  const unranked = listed((c) => c.unranked);
  const unpriced = listed((c) => c.unpriced).filter((id) => !unranked.includes(id));

  const lines = headerLines(data);
  if (rows.size === 0) {
    lines.push("(no added model has both a leaderboard score and a price yet, so there is nothing to compare)");
  } else {
    const shown = categories.map((c) => c.category);
    lines.push(["model", "thinking", "$/task", ...shown.map((c) => CATEGORY_HEADERS[c])].join(" | "));
    const sorted = [...rows.values()].sort((a, b) => a.cost.cost - b.cost.cost || a.modelId.localeCompare(b.modelId));
    for (const row of sorted) {
      const cells = shown.map((category) => {
        const cell = row.scores.get(category);
        return cell === undefined ? "-" : `${cell.text}${cell.borrowed ? "~" : ""}${cell.frontier ? "*" : ""}`;
      });
      lines.push([row.modelId, row.level ?? "default", costCellText(row.cost), ...cells].join(" | "));
    }
  }
  if (unranked.length > 0) lines.push(`Added but not on the Arena board (no score to compare): ${unranked.join(", ")}`);
  if (unpriced.length > 0) {
    lines.push(`Added and scored, but no price known (no tasks run, no list price; the user can enter rates in settings): ${unpriced.join(", ")}`);
  }
  return lines.join("\n");
}

/** modelCostsRequest 的落点：读同一份（带 memo 的）图数据，压成表；算失败回 ok:false，不让工具调用悬死 */
export async function applyModelCosts(source: () => Promise<PriceChartData>): Promise<ModelCostsOutcome> {
  try {
    return { ok: true, text: formatModelCosts(await source()) };
  } catch (cause) {
    return { ok: false, error: `Failed to read the price chart: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
