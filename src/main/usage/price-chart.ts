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
} from "../../shared/price-chart.ts";
import type { Provider } from "../../shared/provider.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/thinking.ts";
import { boardBaseOf, boardEntriesFor, boardIndexOf, type BoardEntry, type BoardRow } from "./arena-board.ts";
import { modelGroups } from "./model-groups.ts";
import {
  estimateTaskCost,
  median,
  taskCost,
  tokenProfile,
  type ChartTask,
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
  /** 价格图的任务全集（task-cost 的 chartTasks：收尾确认的做完的事 + 每个子会话一件） */
  tasks(): Promise<readonly ChartTask[]>;
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
 * 用过、但当前分类的榜单没评的档：**借同型号榜单评过的最高档的分**（用户 2026-10-25：「有些榜单，
 * 没有测，我们就用 max 顶替吧」——推翻 2026-10-24 的方案 b「不借分、单列一组」）。榜单只挑值得测的档
 * 来评，没评的档按最高档的分画，点上标「借分」、图下写明（renderer），不进帕累托前沿（见契约
 * `PriceChartPoint.scoreFrom`）。
 *
 * 只借给用户实测过的档（任意任务数）：没用过的档估算花费与档无关，借了也只是源档那一点的复制。
 * 榜单条目没标档的（GLM-5.3-Flash）不借：那个点的横轴本来就取这个型号全部档位的任务。
 *
 * 横轴的规矩与评过的档一样：够门槛用实测中位数；不够门槛按估算——估算与档无关，源档那一点也是
 * 估算时两点会叠在同一个位置，所以并进源档那一点（`folded`），不另画。
 */
function borrowScores(
  points: PriceChartPoint[],
  modelId: string,
  entries: readonly BoardEntry[],
  used: ReadonlySet<ThinkingLevel> | undefined,
  costsOf: (level: ThinkingLevel) => readonly number[],
  estimate: { cost: number; basis: "estimated" | "reference" } | null,
): void {
  if (used === undefined || entries.some((entry) => entry.thinking === null)) return;
  const source = [...entries].sort(
    (a, b) => THINKING_LEVELS.indexOf(b.thinking ?? "off") - THINKING_LEVELS.indexOf(a.thinking ?? "off"),
  )[0];
  if (source === undefined || source.thinking === null) return;
  const sourcePoint = points.find((point) => point.modelId === modelId && point.thinkingLevel === source.thinking);
  for (const level of THINKING_LEVELS) {
    if (!used.has(level) || entries.some((entry) => entry.thinking === level)) continue;
    const costs = costsOf(level);
    const mid = median(costs);
    if (mid === null) continue;
    const measured = costs.length >= MIN_MEASURED_TASKS;
    let cost: number;
    let costBasis: PriceChartPoint["costBasis"];
    if (measured) {
      cost = mid;
      costBasis = "measured";
    } else if (estimate === null) {
      continue; // 没官方单价定不了估算：与评过的档同一条规矩
    } else if (sourcePoint !== undefined && sourcePoint.costBasis !== "measured") {
      sourcePoint.folded = [...(sourcePoint.folded ?? []), { thinkingLevel: level, samples: costs.length, cost: mid }];
      continue;
    } else {
      cost = estimate.cost;
      costBasis = estimate.basis;
    }
    points.push({
      modelId,
      thinkingLevel: level,
      scoreFrom: source.thinking,
      boardName: source.name,
      ...(source.harness === undefined ? {} : { harness: source.harness }),
      score: source.score,
      scoreLower: source.lower,
      scoreUpper: source.upper,
      cost,
      costBasis,
      samples: measured ? costs.length : 0,
      ...(measured ? {} : { measured: { cost: mid, samples: costs.length } }),
    });
  }
}

export async function buildPriceChart(sources: PriceChartSources, snapshot: ArenaSnapshot): Promise<PriceChartData> {
  const [providers, catalog, stored] = await Promise.all([sources.providers(), sources.catalog(), sources.tasks()]);
  // 档不可考的不在里面（chartTasks 已经筛掉）：计 token、不进图，也不进估算画像
  const tasks = stored.map((task) => ({ task, totals: task.totals }));
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
  /** 每个型号实测过哪些档（榜单没评的档借分要它，见 borrowScores） */
  const usedLevels = new Map<string, Set<ThinkingLevel>>();
  for (const { task, totals } of tasks) {
    const base = boardBaseOf(task.modelId, index);
    if (base === undefined) continue;
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
      if (!anyPriced) {
        unpriced.push(ref);
        continue;
      }
      const base = group.base;
      const estimate =
        group.rates === null
          ? null
          : { cost: estimateTaskCost(group.rates, profile), basis: profile.reference ? ("reference" as const) : ("estimated" as const) };
      borrowScores(
        points,
        group.modelId,
        entries,
        usedLevels.get(base),
        (level) => costs.get(costKey(base, level)) ?? [],
        estimate,
      );
    }
    categories.push({
      category: category satisfies PriceChartCategory,
      unit: (board.unit === "net-improvement" ? "net-improvement" : "rating") satisfies PriceChartScoreUnit,
      publishDate: board.publishDate,
      points,
      unranked,
      unpriced,
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
