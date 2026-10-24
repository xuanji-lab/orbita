/**
 * 「价格 · 能力图」的数据装配 —— IPC 第 2 层身后的计算。**纯模块**（数据源全部注入，不 import
 * electron），可被 `node --test` 直接测。口径见 shared/price-chart.ts（契约）、task-cost.ts
 * （横轴）与 arena-board.ts（纵轴的榜单名映射）。
 *
 * 每次请求只读任务账本（task-ledger.ts，落盘时增量记账）+ 服务商声明 + pi 目录 + 分数快照，
 * 不扫会话。
 */
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import { catalogPreferenceOf, isPlanBilling, knownProviderOf } from "../../shared/known-providers.ts";
import {
  PRICE_CHART_CATEGORIES,
  type PriceChartCategory,
  type PriceChartCategoryData,
  type PriceChartData,
  type PriceChartModelRef,
  type PriceChartPoint,
  type PriceChartScoreUnit,
} from "../../shared/price-chart.ts";
import type { ModelCostDecl, Provider } from "../../shared/provider.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { boardBaseOf, boardEntriesFor, boardIndexOf, type BoardRow } from "./arena-board.ts";
import {
  estimateTaskCost,
  median,
  officialRates,
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

/**
 * 一个型号：同一条榜单基名下的全部已添加（服务商，id）。**一个点 = 型号 × 档**（用户 2026-10-24：
 * 「其实只要看得出模型的数据就好了，不关心它有多少个服务商」）——k3 挂在 Kimi Code、kimi-k3
 * 挂在 Anthropic 兼容，合成一个 Kimi K3。不在任何榜上的 id 各自成组（只进「未上榜」）。
 */
interface ModelGroup {
  /** 榜单基名；不在榜上的 id 为 undefined */
  base: string | undefined;
  /** 代表 id：服务商列表里最先添加的那个（显示名与头像按它取） */
  modelId: string;
  /**
   * 这个型号的官方单价：成员按服务商列表的顺序逐个用 officialRates 查（用户自填 > 本家目录 >
   * 全目录），**取第一个查得到的**。几家查到的价不同时以先添加的那家为准——同一个型号的官方价
   * 本该是一个数，不同多半是某家目录或用户自填有偏差，取哪个都要有个确定的规则。
   */
  rates: ModelCostDecl | null;
}

const groupKey = (base: string | undefined, modelId: string): string =>
  base === undefined ? `id:${modelId}` : `base:${base}`;

const costKey = (base: string, level: ThinkingLevel | "any") => `${base}\u0000${level}`;

export async function buildPriceChart(sources: PriceChartSources, snapshot: ArenaSnapshot): Promise<PriceChartData> {
  const [providers, catalog, stored] = await Promise.all([sources.providers(), sources.catalog(), sources.tasks()]);
  // 档不可考的段（level null）计 token、不进图，也不进估算画像——与改账本之前的口径一致
  const tasks = stored.filter((task) => task.level !== null).map((task) => ({ task, totals: taskTotals(task) }));
  const rowsOf = (category: string): BoardRow[] =>
    (snapshot.categories[category]?.rows ?? []).map(toRow).filter((row): row is BoardRow => row !== null);
  // 手写表之外的兜底：快照里出现过的全部榜单基名（arena-board 的 boardBaseOf）
  const index = boardIndexOf(Object.keys(snapshot.categories).map(rowsOf));
  const groups = new Map<string, ModelGroup>();
  for (const provider of providers) {
    const prefer = catalogPreferenceOf(knownProviderOf(provider), provider.endpoint.api);
    for (const decl of provider.models.declared) {
      const base = boardBaseOf(decl.id, index);
      const k = groupKey(base, decl.id);
      const group = groups.get(k) ?? { base, modelId: decl.id, rates: null };
      group.rates ??= officialRates(catalog, decl.id, prefer, decl.cost);
      groups.set(k, group);
    }
  }

  // 每个（型号，档）与（型号，任意档）的各段花费——各服务商、各别名的任务合在一起。
  // 零价记录（套餐 / 订阅）按这个型号的官方单价折算，与估算同一个价。
  // 任务来自哪家服务商不论（包括现在已经删掉的那家）：花的是这个型号。
  const costs = new Map<string, number[]>();
  const push = (k: string, value: number) => {
    const list = costs.get(k) ?? [];
    list.push(value);
    costs.set(k, list);
  };
  for (const { task, totals } of tasks) {
    const base = boardBaseOf(task.modelId, index);
    if (base === undefined || task.level === null) continue;
    const cost = taskCost(totals, groups.get(`base:${base}`)?.rates ?? null);
    if (cost === null || cost <= 0) continue;
    push(costKey(base, task.level), cost);
    push(costKey(base, "any"), cost);
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
    for (const group of groups.values()) {
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
    }
    categories.push({
      category: category satisfies PriceChartCategory,
      unit: (board.unit === "net-improvement" ? "net-improvement" : "rating") satisfies PriceChartScoreUnit,
      publishDate: board.publishDate,
      points,
      unranked,
      unpriced,
      unratedLevels: [],
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
