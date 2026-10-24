/**
 * 「价格 · 能力图」的数据装配 —— IPC 第 2 层身后的计算。**纯模块**（数据源全部注入，不 import
 * electron），可被 `node --test` 直接测。口径见 shared/price-chart.ts（契约）、task-cost.ts
 * （横轴）与 arena-board.ts（纵轴的榜单名映射）。
 *
 * 每次请求只读任务账本（task-ledger.ts，落盘时增量记账）+ 服务商声明 + pi 目录 + 分数快照，
 * 不扫会话。
 */
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import { isPlanBilling } from "../../shared/known-providers.ts";
import {
  PRICE_CHART_CATEGORIES,
  type PriceChartCategory,
  type PriceChartCategoryData,
  type PriceChartData,
  type PriceChartModelRef,
  type PriceChartPoint,
  type PriceChartScoreUnit,
  type PriceChartUnratedLevel,
} from "../../shared/price-chart.ts";
import type { Provider } from "../../shared/provider.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/thinking.ts";
import { boardBaseOf, boardEntriesFor, boardIndexOf, type BoardRow } from "./arena-board.ts";
import { modelGroups } from "./model-groups.ts";
import {
  estimateTaskCost,
  median,
  taskCost,
  taskTotals,
  tokenProfile,
  type StoredTask,
} from "./task-cost.ts";

/** 快照的形状（scripts/build-arena-snapshot.py 生成） */
export interface ArenaSnapshot {
  dataset: string;
  url: string;
  revision: string;
  license: string;
  attribution: string;
  categories: Record<
    string,
    { unit: string; publishDate: string; rows: (string | number)[][] }
  >;
}

export interface PriceChartSources {
  /** 任务账本里的全部任务（会话 × 型号 × 档的连续一段，按天分账） */
  tasks(): Promise<readonly StoredTask[]>;
  providers(): Promise<Provider[]>;
  catalog(): Promise<BuiltinProvider[]>;
}

function toRow(raw: (string | number)[]): BoardRow | null {
  const [name, score, lower, upper, samples, rank] = raw;
  if (typeof name !== "string") return null;
  if (typeof score !== "number" || typeof lower !== "number" || typeof upper !== "number") return null;
  if (typeof samples !== "number" || typeof rank !== "number") return null;
  return [name, score, lower, upper, samples, rank];
}

/**
 * 实测点的样本门槛（用户 2026-10-24 拍板）：同一个型号 × 档的实测任务（各服务商、各别名合计）
 * **少于 3 个**时，点按估算画（空心、标「估算」），悬停里另写「实测 n 个任务 $x」；满 3 个才用
 * 实测中位数画实心点。理由：中位数在样本很少时就是那一两个任务本身，单个长任务会把点拉偏——
 * 开发版里 Fable 5.1 只有 1 个任务、$29，画成实心点就像「Fable 每个任务要 $29」，而它只是
 * 那一次碰巧很长。
 */
const MIN_MEASURED_TASKS = 3;

const costKey = (base: string, level: ThinkingLevel | "any") => `${base}\u0000${level}`;

/**
 * 用过、但当前分类的榜单没评的档（用户 2026-10-24 拍板，方案 b）：这个型号在榜上有条目，只是没有
 * 这一档——有花费、没有分数。只要这一档有实测任务（任意数量，不受实测门槛限制）就列出来。
 *
 * **不借分数、不画点**：拿最高档的分给高档用，等于替 Arena 编一个它没测过的数；图上的每个点都必须
 * 是榜单真评过的「型号 × 档」。榜单条目是没标档的那种（GLM-5.3-Flash）时不列：那个点的横轴本来就
 * 取这个型号全部档位的任务，没有被漏掉的档。
 */
function unratedOf(
  modelId: string,
  entries: readonly { thinking: ThinkingLevel | null }[],
  used: ReadonlySet<ThinkingLevel> | undefined,
  costsOf: (level: ThinkingLevel) => readonly number[],
): PriceChartUnratedLevel[] {
  if (used === undefined || entries.some((entry) => entry.thinking === null)) return [];
  const rated = THINKING_LEVELS.filter((level) => entries.some((entry) => entry.thinking === level));
  return THINKING_LEVELS.filter((level) => used.has(level) && !rated.includes(level)).flatMap((level) => {
    const costs = costsOf(level);
    const mid = median(costs);
    return mid === null ? [] : [{ modelId, thinkingLevel: level, samples: costs.length, cost: mid, ratedLevels: rated }];
  });
}

export async function buildPriceChart(sources: PriceChartSources, snapshot: ArenaSnapshot): Promise<PriceChartData> {
  const [providers, catalog, stored] = await Promise.all([sources.providers(), sources.catalog(), sources.tasks()]);
  // 档不可考的段（level null）计 token、不进图，也不进估算画像——与改账本之前的口径一致
  const tasks = stored.filter((task) => task.level !== null).map((task) => ({ task, totals: taskTotals(task) }));
  const rowsOf = (category: string): BoardRow[] =>
    (snapshot.categories[category]?.rows ?? []).map(toRow).filter((row): row is BoardRow => row !== null);
  // 手写表之外的兜底：快照里出现过的全部榜单基名（arena-board 的 boardBaseOf）
  const index = boardIndexOf(Object.keys(snapshot.categories).map(rowsOf));
  // 「一个型号」的口径（别名合并、官方单价取哪家）与侧栏用量格共用：model-groups.ts
  const models = modelGroups(providers, catalog, index);
  const rateOfBase = new Map(models.added.flatMap((g) => (g.base === undefined ? [] : [[g.base, g.rates] as const])));

  // 每个（型号，档）与（型号，任意档）的各段花费——各服务商、各别名的任务合在一起。
  // 零价记录（套餐 / 订阅）按这个型号的官方单价折算，与估算同一个价。
  // 任务来自哪家服务商不论（包括现在已经删掉的那家）：花的是这个型号。
  const costs = new Map<string, number[]>();
  const push = (k: string, value: number) => {
    const list = costs.get(k) ?? [];
    list.push(value);
    costs.set(k, list);
  };
  /** 每个型号实测过哪些档（「用过、但榜单没评的档」要它） */
  const usedLevels = new Map<string, Set<ThinkingLevel>>();
  for (const { task, totals } of tasks) {
    const base = boardBaseOf(task.modelId, index);
    if (base === undefined || task.level === null) continue;
    const cost = taskCost(totals, rateOfBase.get(base) ?? null);
    if (cost === null || cost <= 0) continue;
    push(costKey(base, task.level), cost);
    push(costKey(base, "any"), cost);
    usedLevels.set(base, (usedLevels.get(base) ?? new Set()).add(task.level));
  }
  const profile = tokenProfile(tasks.map((t) => t.totals));

  const categories: PriceChartCategoryData[] = [];
  for (const category of PRICE_CHART_CATEGORIES) {
    const board = snapshot.categories[category];
    if (board === undefined) continue;
    const rows = rowsOf(category);
    const points: PriceChartPoint[] = [];
    const unranked: PriceChartModelRef[] = [];
    const unpriced: PriceChartModelRef[] = [];
    const unratedLevels: PriceChartUnratedLevel[] = [];
    for (const group of models.added) {
      const ref = { modelId: group.modelId };
      const entries = group.base === undefined ? [] : boardEntriesFor(rows, group.modelId, board.publishDate, index);
      if (group.base === undefined || entries.length === 0) {
        unranked.push(ref);
        continue;
      }
      let anyPriced = false;
      for (const entry of entries) {
        const measured = costs.get(costKey(group.base, entry.thinking ?? "any")) ?? [];
        const mid = median(measured);
        let cost: number;
        let costBasis: PriceChartPoint["costBasis"];
        if (mid !== null && measured.length >= MIN_MEASURED_TASKS) {
          cost = mid;
          costBasis = "measured";
        } else if (group.rates !== null) {
          // 没跑过，或跑过但不够门槛：按估算画；不够门槛的实测随点带上，悬停里另写一行
          cost = estimateTaskCost(group.rates, profile);
          costBasis = profile.reference ? "reference" : "estimated";
        } else {
          // 估算要官方单价：找不到就定不了横轴（哪怕有一两个实测任务），列进「缺官方单价」
          continue;
        }
        if (!(cost > 0)) continue;
        anyPriced = true;
        points.push({
          ...ref,
          thinkingLevel: entry.thinking,
          boardName: entry.name,
          ...(entry.harness === undefined ? {} : { harness: entry.harness }),
          score: entry.score,
          scoreLower: entry.lower,
          scoreUpper: entry.upper,
          cost,
          costBasis,
          samples: costBasis === "measured" ? measured.length : 0,
          ...(costBasis !== "measured" && mid !== null ? { measured: { cost: mid, samples: measured.length } } : {}),
        });
      }
      if (!anyPriced) unpriced.push(ref);
      const base = group.base;
      unratedLevels.push(
        ...unratedOf(group.modelId, entries, usedLevels.get(base), (level) => costs.get(costKey(base, level)) ?? []),
      );
    }
    categories.push({
      category: category satisfies PriceChartCategory,
      unit: (board.unit === "net-improvement" ? "net-improvement" : "rating") satisfies PriceChartScoreUnit,
      publishDate: board.publishDate,
      points,
      unranked,
      unpriced,
      unratedLevels,
    });
  }

  return {
    categories,
    profile,
    hasPlanProvider: providers.some((provider) => isPlanBilling(provider)),
    source: {
      dataset: snapshot.dataset,
      url: snapshot.url,
      revision: snapshot.revision,
      license: snapshot.license,
      attribution: snapshot.attribution,
    },
  };
}
