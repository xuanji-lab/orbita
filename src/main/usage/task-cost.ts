/**
 * 「每任务成本」的口径 —— 价格 · 能力图的横轴。**纯模块**：不 import electron，可被 `node --test` 直接测。
 *
 * ## 什么是一个任务（用户 2026-10-24 拍板）
 * **一个会话就是一个任务**（「一个 session 就是一个任务」）：
 * - 会话中途没换型号、也没换思考档的，整个会话是一个任务；用户消息不切，一个任务里可以有很多轮。
 * - 中途换过型号或档的，在切换点切开，各段各自记账（「中途切换了模型，也是可以截断的」）。
 *   所以一个任务 = 一个会话里同一型号 × 同一思考档的连续一段。
 * - 子会话本身就是独立的会话，单独算任务；父会话的成本**不**并入子会话，子会话的也不并入父会话
 *   （切段按会话各自的记录做，从不跨会话拼接）。
 *
 * ## 每条回复花了多少
 * assistant 记录的 `usage.cost.total` 大于 0 就用它（落盘时 pi 按当时费率算好的）；等于 0 而
 * token 不为 0 的（套餐 / 订阅：Kimi Code、智谱 Coding Plan、Claude 订阅，pi 目录里单价是 0），
 * 按官方单价现算——「套餐与订阅按官方单价折算」。官方单价找不到的，这一段花费未知，不进中位数。
 *
 * ## 每一轮是哪一档
 * 新记录：recorder 在落盘时盖上这一轮的生效档（`StampedAssistantRecord.thinkingLevel`）。
 * 旧记录（盖章之前）：按 pi 本子里的 `thinking_level_change` 时间线补——但 pi 只在建会话与
 * 手动压缩前后写这一条，会话中途改档不写。所以时间线只在**能自证没漏**时采信：它的最后一档
 * 必须等于锚点（会话里第一条盖了章的记录的档；一条都没盖就是 meta 当前的档）。对不上 = 中途
 * 改过档且没记下，这条会话没盖章的部分整段不计——宁缺，不猜。
 * 已知盲区：中途改了又改回原档（high → max → high），最后一档对得上、中间那段会记成 high。
 *
 * ## 在哪算（2026-10-24 改）
 * 不再在打开设置页时扫全部会话（开发版 137 条、334MB，冷启动约 1.6s，主进程里解析会和界面
 * 抢事件循环）：recorder 每落一条 assistant 记录就经 appendTaskRecord 增量记进任务账本
 * （task-ledger.ts），升级后第一次启动回填一次。图只读账本。
 *
 * ## 不计的
 * 导入会话（花在别的应用上）；空 error 回答（auto_retry 的失败尝试，store.ts 的谓词）；没有 usage
 * 的记录；分支复制出的前缀（同一条消息 id 只计一次，与日账本同一个去重）。
 */
import type { ModelCostDecl } from "../../shared/provider.ts";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import { lookupCatalogModel, type CatalogPreference } from "../../shared/model-defaults.ts";
import { stampedThinkingLevel, type SessionRecord } from "../../shared/session.ts";
import { isThinkingLevel, type ThinkingLevel } from "../../shared/thinking.ts";
import type { PriceChartProfile } from "../../shared/price-chart.ts";
import { isEmptyErrorAssistant } from "../session/store.ts";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function tokenTotal(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** pi 本子里的一次档位变化（时间戳毫秒） */
export interface LevelChange {
  at: number;
  level: ThinkingLevel;
}

/** pi 本子（JSONL 文本）→ 档位时间线，按出现顺序。坏行跳过 */
export function piThinkingTimeline(piFileText: string): LevelChange[] {
  const out: LevelChange[] = [];
  for (const line of piFileText.split("\n")) {
    if (!line.includes("thinking_level_change")) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (e["type"] !== "thinking_level_change" || !isThinkingLevel(e["thinkingLevel"])) continue;
      const at = typeof e["timestamp"] === "string" ? Date.parse(e["timestamp"]) : Number.NaN;
      if (!Number.isFinite(at)) continue;
      out.push({ at, level: e["thinkingLevel"] });
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/**
 * 一条会话里每条 assistant 记录的档：盖了章用章；没盖的按 pi 时间线补（能自证没漏才补，见文件头）。
 * 返回 undefined = 这一条的档无从可考，不计。
 */
function levelResolver(
  records: readonly SessionRecord[],
  timeline: readonly LevelChange[],
  metaLevel: ThinkingLevel,
): (record: SessionRecord) => ThinkingLevel | undefined {
  let anchor: ThinkingLevel = metaLevel;
  for (const record of records) {
    const stamped = stampedThinkingLevel(record);
    if (stamped !== undefined) {
      anchor = stamped;
      break;
    }
  }
  const last = timeline[timeline.length - 1];
  const trusted = last !== undefined && last.level === anchor;
  return (record) => {
    const stamped = stampedThinkingLevel(record);
    if (stamped !== undefined) return stamped;
    if (!trusted) return undefined;
    let level = timeline[0]?.level;
    for (const change of timeline) {
      if (change.at <= record.timestamp) level = change.level;
      else break;
    }
    return level;
  };
}

/**
 * 一条 assistant 记录里切段与记账要的全部信息（落盘那一刻由 recorder 交给任务账本，回填时由
 * taskRecordsOf 从会话 JSONL 里取）。level 缺席 = 这一条的档无从可考。
 */
export interface TaskRecord {
  id: string;
  providerId: string;
  modelId: string;
  level?: ThinkingLevel;
  tokens: TokenCounts;
  /** 记录上的 usage.cost.total */
  cost: number;
  /** 记录时刻（epoch ms）：按本地日期分天记账用 */
  timestamp: number;
}

/**
 * 一条记录 → 紧凑形。不是带 usage、非空 error 的 assistant 记录返回 null。
 * level 由调用方给（落盘时就是记录上盖的章；回填时由 levelResolver 补）。
 */
export function taskRecordOf(record: SessionRecord, level: ThinkingLevel | undefined): TaskRecord | null {
  if (record.role !== "assistant" || record.usage === undefined || isEmptyErrorAssistant(record)) return null;
  const usage = record.usage;
  return {
    id: record.id,
    providerId: record.model.provider,
    modelId: record.model.id,
    ...(level === undefined ? {} : { level }),
    tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
    cost: usage.cost.total,
    timestamp: record.timestamp,
  };
}

/**
 * 一条会话的原始记录 → 紧凑形（回填用）。档按 levelResolver 定：盖章优先，旧记录按 pi 时间线补，
 * 补不了就缺席。
 */
export function taskRecordsOf(
  records: readonly SessionRecord[],
  timeline: readonly LevelChange[],
  metaLevel: ThinkingLevel,
): TaskRecord[] {
  const levelOf = levelResolver(records, timeline, metaLevel);
  const out: TaskRecord[] = [];
  for (const record of records) {
    const item = taskRecordOf(record, record.role === "assistant" ? levelOf(record) : undefined);
    if (item !== null) out.push(item);
  }
  return out;
}

/** 一天里的账：全部 token、记录上自带的花费（cost.total > 0 的那些）、零价记录的 token（要按官方单价折算） */
export interface DayCounts {
  tokens: TokenCounts;
  recordedCost: number;
  unpricedTokens: TokenCounts;
}

const ZERO_DAY: DayCounts = { tokens: ZERO_TOKENS, recordedCost: 0, unpricedTokens: ZERO_TOKENS };

function addDay(a: DayCounts, b: DayCounts): DayCounts {
  return {
    tokens: addTokens(a.tokens, b.tokens),
    recordedCost: a.recordedCost + b.recordedCost,
    unpricedTokens: addTokens(a.unpricedTokens, b.unpricedTokens),
  };
}

/**
 * 一个任务（会话里同一型号 × 同一档的连续一段），**按本地日期分天记账**：价格 · 能力图要每个
 * 任务的合计（taskTotals）；侧栏用量格将来要「按天、按型号」的汇总，直接从 days 里取，不用改结构。
 */
export interface StoredTask {
  sessionId: string;
  providerId: string;
  modelId: string;
  /**
   * null = 这一段的档无从可考（盖章之前、pi 时间线又对不上的旧记录）。**照样记账**：token 是真花了的，
   * 按天的汇总（侧栏用量格）要和日账本对得上；价格 · 能力图按「型号 × 档」画，跳过它们。
   */
  level: ThinkingLevel | null;
  days: Record<string, DayCounts>;
}

/** 任务账：全部任务（只追加，下标稳定）+ 每条会话当前那一段的下标 */
export interface TaskBook {
  tasks: StoredTask[];
  open: Map<string, number>;
}

export function emptyTaskBook(): TaskBook {
  return { tasks: [], open: new Map() };
}

/**
 * **切段的唯一实现**：往账里记一条。回填（按会话逐条喂）与落盘时的增量记账走的都是它，两条路径
 * 因此算出同一本账。去重（同一条消息 id 只计一次）是调用方的事。
 *
 * - 与当前段的服务商、型号、档都相同：并进去；否则另起一段。
 * - 档不可考的记录记进「档 = null」的段：它与前后有档的记录档不同，自然切开——两边不会被拼成
 *   同一个任务，而 token 仍在账上。
 * - token 与花费全是 0 的记录不计，也不切段。
 */
export function appendTaskRecord(
  book: TaskBook,
  sessionId: string,
  record: TaskRecord,
  dateOf: (timestamp: number) => string,
): void {
  if (tokenTotal(record.tokens) === 0 && !(record.cost > 0)) return;
  const level = record.level ?? null;
  const at = book.open.get(sessionId);
  let task = at === undefined ? undefined : book.tasks[at];
  if (
    task === undefined ||
    task.providerId !== record.providerId ||
    task.modelId !== record.modelId ||
    task.level !== level
  ) {
    task = { sessionId, providerId: record.providerId, modelId: record.modelId, level, days: {} };
    book.tasks.push(task);
    book.open.set(sessionId, book.tasks.length - 1);
  }
  const priced = Number.isFinite(record.cost) && record.cost > 0;
  const day: DayCounts = {
    tokens: record.tokens,
    recordedCost: priced ? record.cost : 0,
    unpricedTokens: priced ? ZERO_TOKENS : record.tokens,
  };
  const date = dateOf(record.timestamp);
  task.days[date] = addDay(task.days[date] ?? ZERO_DAY, day);
}

/** 一个任务各天合计 */
export function taskTotals(task: StoredTask): DayCounts {
  return Object.values(task.days).reduce(addDay, ZERO_DAY);
}

/** 按单价（$ / 百万 token）给一堆 token 算钱 */
function priceTokens(tokens: TokenCounts, rates: ModelCostDecl): number {
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}

/** 一个任务的花费：自带的 + 零价记录按官方单价折算。有零价 token 而没有单价 → null（未知） */
export function taskCost(totals: DayCounts, rates: ModelCostDecl | null): number | null {
  if (tokenTotal(totals.unpricedTokens) === 0) return totals.recordedCost;
  if (rates === null) return null;
  return totals.recordedCost + priceTokens(totals.unpricedTokens, rates);
}

/** 中位数；空数组 null。偶数个取中间两个的平均 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

/**
 * 用户一个任务都没有时的兜底画像。**参考画像：作者本机开发数据聚合，2026-10**——只有两类汇总值：
 * token 构成（约 95% 缓存读取、4% 缓存写入、1% 新输入、0.3% 输出，按和为 1 归一）与任务 token 量的
 * 中位数。不含任何能追溯到具体会话的内容。
 */
const REFERENCE_PROFILE: PriceChartProfile = (() => {
  const raw = { input: 1, output: 0.3, cacheRead: 95, cacheWrite: 4 };
  const sum = raw.input + raw.output + raw.cacheRead + raw.cacheWrite;
  return {
    taskCount: 0,
    medianTaskTokens: 4_100_000,
    mix: {
      input: raw.input / sum,
      output: raw.output / sum,
      cacheRead: raw.cacheRead / sum,
      cacheWrite: raw.cacheWrite / sum,
    },
    reference: true,
  };
})();

/** 用户自己的 token 画像：构成按全部任务的 token 加权，任务量取全部任务 token 量的中位数 */
export function tokenProfile(totals: readonly DayCounts[]): PriceChartProfile {
  const total = totals.reduce((sum, task) => addTokens(sum, task.tokens), ZERO_TOKENS);
  const all = tokenTotal(total);
  const mid = median(totals.map((task) => tokenTotal(task.tokens)));
  if (all === 0 || mid === null) return REFERENCE_PROFILE;
  return {
    taskCount: totals.length,
    medianTaskTokens: mid,
    mix: {
      input: total.input / all,
      output: total.output / all,
      cacheRead: total.cacheRead / all,
      cacheWrite: total.cacheWrite / all,
    },
    reference: false,
  };
}

/** 没用过的型号 × 档的估算：官方单价按画像的 token 构成加权，再乘任务 token 中位数（美元 / 任务） */
export function estimateTaskCost(rates: ModelCostDecl, profile: PriceChartProfile): number {
  const perToken =
    (profile.mix.input * rates.input +
      profile.mix.output * rates.output +
      profile.mix.cacheRead * rates.cacheRead +
      profile.mix.cacheWrite * rates.cacheWrite) /
    1_000_000;
  return perToken * profile.medianTaskTokens;
}

function isPriced(cost: ModelCostDecl | undefined): cost is ModelCostDecl {
  return cost !== undefined && cost.input + cost.output + cost.cacheRead + cost.cacheWrite > 0;
}

/**
 * 这个（服务商，型号）的**官方单价**：用户自填的（非全零）> 本家目录（与会话注册同一条查找，
 * 本家 > 同协议 > 其余 > Claude 家族）> 全目录里同 id 的非零单价（同协议先）。都没有 → null。
 *
 * 全零不算数：套餐目录（zai-coding-cn、qwen-token-plan）的同一型号单价是 0，那是「包月不按量」，
 * 不是「这个型号不要钱」——图要的是官方按量价，往下找。
 */
export function officialRates(
  catalog: readonly BuiltinProvider[],
  modelId: string,
  prefer: CatalogPreference,
  declared: ModelCostDecl | undefined,
): ModelCostDecl | null {
  if (isPriced(declared)) return { ...declared };
  const home = lookupCatalogModel(catalog, modelId, prefer)?.cost;
  if (isPriced(home)) return { ...home };
  const ordered = [...catalog].sort((a, b) => {
    const rank = (p: BuiltinProvider) => (prefer.api !== undefined && p.api === prefer.api ? 0 : 1);
    return rank(a) - rank(b);
  });
  for (const provider of ordered) {
    const cost = provider.models.find((model) => model.id === modelId)?.cost;
    if (isPriced(cost)) return { ...cost };
  }
  return null;
}
