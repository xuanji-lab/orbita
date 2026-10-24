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
interface LevelChange {
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
 * 一条 assistant 记录里切段与记账要的全部信息（会话扫描后的紧凑形，主进程按会话缓存它，
 * 不必每次请求都重读几百个 JSONL）。level 缺席 = 这一条的档无从可考。
 */
export interface TaskRecord {
  id: string;
  providerId: string;
  modelId: string;
  level?: ThinkingLevel;
  tokens: TokenCounts;
  /** 记录上的 usage.cost.total */
  cost: number;
}

/**
 * 一条会话的原始记录 → 紧凑形。只收带 usage、非空 error 的 assistant 记录；档按
 * levelResolver 定（盖章优先，旧记录按 pi 时间线补，补不了就缺席）。
 */
export function taskRecordsOf(
  records: readonly SessionRecord[],
  timeline: readonly LevelChange[],
  metaLevel: ThinkingLevel,
): TaskRecord[] {
  const levelOf = levelResolver(records, timeline, metaLevel);
  const out: TaskRecord[] = [];
  for (const record of records) {
    if (record.role !== "assistant" || record.usage === undefined || isEmptyErrorAssistant(record)) continue;
    const usage = record.usage;
    const level = levelOf(record);
    out.push({
      id: record.id,
      providerId: record.model.provider,
      modelId: record.model.id,
      ...(level === undefined ? {} : { level }),
      tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
      cost: usage.cost.total,
    });
  }
  return out;
}

/** 一个任务段 */
export interface TaskSegment {
  providerId: string;
  modelId: string;
  level: ThinkingLevel;
  /** 段内全部记录的 token */
  tokens: TokenCounts;
  /** 记录上自带的花费（cost.total > 0 的那些）之和 */
  recordedCost: number;
  /** cost.total 为 0 的记录的 token：要按官方单价折算 */
  unpricedTokens: TokenCounts;
}

/**
 * 切段（一条会话的记录，按落盘顺序）。`seen` 跨会话共享：分支复制的前缀带着同样的消息 id，
 * 只计第一次见到的那条。档无从可考的记录**断开当前段**且自己不计：它两边的记录不能被
 * 拼成同一个任务。
 */
export function segmentTasks(records: readonly TaskRecord[], seen: Set<string>): TaskSegment[] {
  const segments: TaskSegment[] = [];
  let current: TaskSegment | null = null;
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const level = record.level;
    if (level === undefined) {
      current = null;
      continue;
    }
    if (
      current === null ||
      current.providerId !== record.providerId ||
      current.modelId !== record.modelId ||
      current.level !== level
    ) {
      current = {
        providerId: record.providerId,
        modelId: record.modelId,
        level,
        tokens: ZERO_TOKENS,
        recordedCost: 0,
        unpricedTokens: ZERO_TOKENS,
      };
      segments.push(current);
    }
    current.tokens = addTokens(current.tokens, record.tokens);
    if (Number.isFinite(record.cost) && record.cost > 0) current.recordedCost += record.cost;
    else current.unpricedTokens = addTokens(current.unpricedTokens, record.tokens);
  }
  return segments.filter((segment) => tokenTotal(segment.tokens) > 0);
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

/** 一段的花费：自带的 + 零价记录按官方单价折算。有零价 token 而没有单价 → null（未知） */
export function segmentCost(segment: TaskSegment, rates: ModelCostDecl | null): number | null {
  if (tokenTotal(segment.unpricedTokens) === 0) return segment.recordedCost;
  if (rates === null) return null;
  return segment.recordedCost + priceTokens(segment.unpricedTokens, rates);
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
export function tokenProfile(segments: readonly TaskSegment[]): PriceChartProfile {
  const total = segments.reduce((sum, segment) => addTokens(sum, segment.tokens), ZERO_TOKENS);
  const all = tokenTotal(total);
  const mid = median(segments.map((segment) => tokenTotal(segment.tokens)));
  if (all === 0 || mid === null) return REFERENCE_PROFILE;
  return {
    taskCount: segments.length,
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
