/**
 * 「价格 · 能力图」的数据装配 —— IPC 第 2 层身后的计算。**纯模块**（数据源全部注入，不 import
 * electron），可被 `node --test` 直接测。口径见 shared/price-chart.ts（契约）、task-cost.ts
 * （横轴）与 arena-board.ts（纵轴的榜单名映射）。
 *
 * 每次请求现算：读全部非导入会话的原始 JSONL（含被回退的轮——钱花了，与日账本同一口径），
 * 没盖章的会话再读一遍 pi 本子拿档位时间线。
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
import { stampedThinkingLevel, type SessionMeta, type SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { boardBaseOf, boardEntriesFor, type BoardRow } from "./arena-board.ts";
import {
  estimateTaskCost,
  median,
  officialRates,
  piThinkingTimeline,
  segmentCost,
  segmentTasks,
  taskRecordsOf,
  tokenProfile,
  type TaskRecord,
  type TaskSegment,
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
  sessions: {
    list(): Promise<SessionMeta[]>;
    readRawLog(id: string): Promise<SessionRecord[]>;
  };
  /** 读 pi 本子全文；不存在 / 读不了返回 null */
  readPiFile(path: string): Promise<string | null>;
  providers(): Promise<Provider[]>;
  catalog(): Promise<BuiltinProvider[]>;
}

/** 历史会话的采信统计（PR 描述里报「丢了多少条」用；也落一条日志） */
export interface ScanStats {
  sessions: number;
  /** 有没盖章的记录、且 pi 时间线与锚点对不上，整条没盖章的部分丢弃 */
  untrusted: number;
}

function toRow(raw: (string | number)[]): BoardRow | null {
  const [name, score, lower, upper, samples, rank] = raw;
  if (typeof name !== "string") return null;
  if (typeof score !== "number" || typeof lower !== "number" || typeof upper !== "number") return null;
  if (typeof samples !== "number" || typeof rank !== "number") return null;
  return [name, score, lower, upper, samples, rank];
}

/** 一条会话扫描后的缓存项：meta 的 updatedAt 与档没变就复用（每条新记录都会推进 updatedAt） */
export interface SessionScan {
  updatedAt: number;
  thinkingLevel: ThinkingLevel;
  records: TaskRecord[];
  untrusted: boolean;
}

/**
 * 扫会话切段。返回段与采信统计。`cache` 跨请求复用（ipc 层持有一份）：首次打开设置页要读
 * 全部会话（开发版 137 条原生会话实测约 1.5s），之后只重读变过的。
 */
async function scanTasks(
  sources: PriceChartSources,
  cache: Map<string, SessionScan> = new Map(),
): Promise<{ segments: TaskSegment[]; stats: ScanStats }> {
  const seen = new Set<string>();
  const segments: TaskSegment[] = [];
  const stats: ScanStats = { sessions: 0, untrusted: 0 };
  // 时间正序：分支复制的前缀在原会话里先见到，计在原会话名下
  const metas = (await sources.sessions.list())
    .filter((meta) => meta.importedFrom === undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
  const live = new Set<string>();
  for (const meta of metas) {
    live.add(meta.id);
    let scan = cache.get(meta.id);
    if (scan === undefined || scan.updatedAt !== meta.updatedAt || scan.thinkingLevel !== meta.thinkingLevel) {
      scan = await scanSession(sources, meta);
      cache.set(meta.id, scan);
    }
    if (scan.records.length === 0) continue;
    stats.sessions += 1;
    if (scan.untrusted) stats.untrusted += 1;
    segments.push(...segmentTasks(scan.records, seen));
  }
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  return { segments, stats };
}

async function scanSession(sources: PriceChartSources, meta: SessionMeta): Promise<SessionScan> {
  const raw = await sources.sessions.readRawLog(meta.id);
  const base = { updatedAt: meta.updatedAt, thinkingLevel: meta.thinkingLevel };
  const needsTimeline = raw.some(
    (record) => record.role === "assistant" && record.usage !== undefined && stampedThinkingLevel(record) === undefined,
  );
  const piText = needsTimeline && meta.piSessionFile !== null ? await sources.readPiFile(meta.piSessionFile) : null;
  const records = taskRecordsOf(raw, piText === null ? [] : piThinkingTimeline(piText), meta.thinkingLevel);
  return { ...base, records, untrusted: records.some((record) => record.level === undefined) };
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

const groupKey = (modelId: string): string => {
  const base = boardBaseOf(modelId);
  return base === undefined ? `id:${modelId}` : `base:${base}`;
};

const costKey = (base: string, level: ThinkingLevel | "any") => `${base}\u0000${level}`;

export async function buildPriceChart(
  sources: PriceChartSources,
  snapshot: ArenaSnapshot,
  cache?: Map<string, SessionScan>,
): Promise<{ data: PriceChartData; stats: ScanStats }> {
  const [providers, catalog, scanned] = await Promise.all([
    sources.providers(),
    sources.catalog(),
    scanTasks(sources, cache),
  ]);
  const groups = new Map<string, ModelGroup>();
  for (const provider of providers) {
    const prefer = catalogPreferenceOf(knownProviderOf(provider), provider.endpoint.api);
    for (const decl of provider.models.declared) {
      const k = groupKey(decl.id);
      const group = groups.get(k) ?? { base: boardBaseOf(decl.id), modelId: decl.id, rates: null };
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
  for (const segment of scanned.segments) {
    const base = boardBaseOf(segment.modelId);
    if (base === undefined) continue;
    const cost = segmentCost(segment, groups.get(`base:${base}`)?.rates ?? null);
    if (cost === null || cost <= 0) continue;
    push(costKey(base, segment.level), cost);
    push(costKey(base, "any"), cost);
  }
  const profile = tokenProfile(scanned.segments);

  const categories: PriceChartCategoryData[] = [];
  for (const category of PRICE_CHART_CATEGORIES) {
    const board = snapshot.categories[category];
    if (board === undefined) continue;
    const rows = board.rows.map(toRow).filter((row): row is BoardRow => row !== null);
    const points: PriceChartPoint[] = [];
    const unranked: PriceChartModelRef[] = [];
    const unpriced: PriceChartModelRef[] = [];
    for (const group of groups.values()) {
      const ref = { modelId: group.modelId };
      const entries = group.base === undefined ? [] : boardEntriesFor(rows, group.modelId, board.publishDate);
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
    data: {
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
    },
    stats: scanned.stats,
  };
}
