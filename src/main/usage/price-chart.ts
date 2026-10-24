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
import { boardEntriesFor, type BoardRow } from "./arena-board.ts";
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

interface AddedModel {
  provider: Provider;
  modelId: string;
  rates: ModelCostDecl | null;
}

const key = (providerId: string, modelId: string, level: ThinkingLevel | "any") =>
  `${providerId}\u0000${modelId}\u0000${level}`;

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
  const added: AddedModel[] = providers.flatMap((provider) => {
    const prefer = catalogPreferenceOf(knownProviderOf(provider), provider.endpoint.api);
    return provider.models.declared.map((decl) => ({
      provider,
      modelId: decl.id,
      rates: officialRates(catalog, decl.id, prefer, decl.cost),
    }));
  });
  const ratesByModel = new Map(added.map((m) => [`${m.provider.id}\u0000${m.modelId}`, m.rates]));

  // 每个（服务商，型号，档）与（服务商，型号，任意档）的各段花费
  const costs = new Map<string, number[]>();
  const push = (k: string, value: number) => {
    const list = costs.get(k) ?? [];
    list.push(value);
    costs.set(k, list);
  };
  for (const segment of scanned.segments) {
    const rates = ratesByModel.get(`${segment.providerId}\u0000${segment.modelId}`) ?? null;
    const cost = segmentCost(segment, rates);
    if (cost === null || cost <= 0) continue;
    push(key(segment.providerId, segment.modelId, segment.level), cost);
    push(key(segment.providerId, segment.modelId, "any"), cost);
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
    for (const model of added) {
      const ref = { providerId: model.provider.id, modelId: model.modelId };
      const entries = boardEntriesFor(rows, model.modelId, board.publishDate);
      if (entries.length === 0) {
        unranked.push(ref);
        continue;
      }
      let anyPriced = false;
      for (const entry of entries) {
        const measured = costs.get(key(model.provider.id, model.modelId, entry.thinking ?? "any")) ?? [];
        const mid = median(measured);
        let cost: number;
        let costBasis: PriceChartPoint["costBasis"];
        if (mid !== null) {
          cost = mid;
          costBasis = "measured";
        } else if (model.rates !== null) {
          cost = estimateTaskCost(model.rates, profile);
          costBasis = profile.reference ? "reference" : "estimated";
        } else {
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
