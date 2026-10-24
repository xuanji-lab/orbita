/**
 * 「每任务成本」的口径 —— 价格 · 能力图的横轴。**纯模块**：不 import electron，可被 `node --test` 直接测。
 *
 * ## 什么是一个任务（用户 2026-10-24 拍板，第二版）
 * 「点一次打勾就算完成一次任务」——**主会话里，一个任务 = 收尾时确认的一件「做完的事」**：
 * - 花费 = 那几轮的合计；算给那几轮里 token 最多的型号 × 档（用户只接受这一条规则）。
 *   数字在确认那一刻算好、落在 meta.wrapups（main/session/wrapup.ts），账本照抄。
 * - 没确认过的主会话不进实测；收尾扫描那一轮不属于任何一轮，因此不算进任何一件事。
 * - **子会话**不弹收尾卡，交回结果就算一件做完的事：整个子会话一个任务，同样算给 token 最多的
 *   型号 × 档。
 *
 * 账本里另有一份「会话 × 型号 × 档的连续一段」（StoredTask）：那是**按天记 token** 用的
 * （侧栏用量格的每日合计，收尾轮次照算——那是真实花掉的 token），不再是价格图的任务。
 * 第一版「一个会话里同一型号 × 同一档的连续一段 = 一个任务」只剩切段这一层意思。
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
    const change = levelChangeOfLine(line);
    if (change !== null) out.push(change);
  }
  return out;
}

/**
 * pi 本子的一行 → 档位变化；不是 thinking_level_change 条目 / 坏行返回 null。
 * piThinkingTimeline 与回填的流式读（task-ledger 的 readPiThinkingTimeline）共用这一处判定。
 */
export function levelChangeOfLine(line: string): LevelChange | null {
  if (!line.includes("thinking_level_change")) return null;
  try {
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (e["type"] !== "thinking_level_change" || !isThinkingLevel(e["thinkingLevel"])) return null;
    const at = typeof e["timestamp"] === "string" ? Date.parse(e["timestamp"]) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    return { at, level: e["thinkingLevel"] };
  } catch {
    return null; // 坏行跳过
  }
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

/** 价格图上的一个任务（收尾确认的一件做完的事，或一个子会话） */
export interface ChartTask {
  providerId: string;
  modelId: string;
  level: ThinkingLevel;
  totals: DayCounts;
}

/** 收尾确认的一件做完的事（账本里存的形状）：wrapupId 去重用 */
export interface StoredDone {
  sessionId: string;
  wrapupId: string;
  providerId: string;
  modelId: string;
  level: ThinkingLevel;
  totals: DayCounts;
}

/**
 * 一次收尾记录 → 账本里的做完的事。没有归属（没指定轮次 / 那几轮没用量）或档不可考的不收：
 * 价格图按「型号 × 档」画，它们落不到任何一个点上。
 */
export function storedDonesOf(
  sessionId: string,
  wrapup: { id: string; items: readonly { providerId: string | null; modelId: string | null; level: ThinkingLevel | null; tokens: TokenCounts; recordedCost: number; unpricedTokens: TokenCounts }[] },
): StoredDone[] {
  return wrapup.items.flatMap((item) =>
    item.providerId === null || item.modelId === null || item.level === null || (tokenTotal(item.tokens) === 0 && !(item.recordedCost > 0))
      ? []
      : [
          {
            sessionId,
            wrapupId: wrapup.id,
            providerId: item.providerId,
            modelId: item.modelId,
            level: item.level,
            totals: { tokens: { ...item.tokens }, recordedCost: item.recordedCost, unpricedTokens: { ...item.unpricedTokens } },
          },
        ],
  );
}

/**
 * 价格图的任务全集：确认的做完的事 + 每个子会话一件（整个子会话合计，算给 token 最多的
 * 「服务商 × 型号 × 档」；最多的那组档不可考就不收）。没确认过的主会话不在里面。
 */
export function chartTasks(
  segments: readonly StoredTask[],
  dones: readonly StoredDone[],
  childIds: ReadonlySet<string>,
): ChartTask[] {
  const out: ChartTask[] = dones.map((done) => ({
    providerId: done.providerId,
    modelId: done.modelId,
    level: done.level,
    totals: done.totals,
  }));
  const children = new Map<string, Map<string, { providerId: string; modelId: string; level: ThinkingLevel | null; totals: DayCounts }>>();
  for (const segment of segments) {
    if (!childIds.has(segment.sessionId)) continue;
    const groups = children.get(segment.sessionId) ?? new Map();
    const key = `${segment.providerId}\u0000${segment.modelId}\u0000${segment.level ?? ""}`;
    const prev = groups.get(key);
    const totals = taskTotals(segment);
    groups.set(key, {
      providerId: segment.providerId,
      modelId: segment.modelId,
      level: segment.level,
      totals: prev === undefined ? totals : addDay(prev.totals, totals),
    });
    children.set(segment.sessionId, groups);
  }
  for (const groups of children.values()) {
    let top: { providerId: string; modelId: string; level: ThinkingLevel | null; totals: DayCounts } | null = null;
    let all = ZERO_DAY;
    for (const group of groups.values()) {
      all = addDay(all, group.totals);
      if (top === null || tokenTotal(group.totals.tokens) > tokenTotal(top.totals.tokens)) top = group;
    }
    if (top === null || top.level === null) continue;
    out.push({ providerId: top.providerId, modelId: top.modelId, level: top.level, totals: all });
  }
  return out;
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
