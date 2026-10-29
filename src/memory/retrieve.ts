/**
 * 召回打分（移植自已关闭的 PR #228 的 retrieve.ts，按新条目形状改写）——
 * **关键词重叠 + 正文 token 重叠 + 轻度时间衰减**，出门过三道闸：阈值门控 →
 * top N → 总字符预算。**纯模块**，可被 `node --test` 直接加载。
 *
 * 为什么词法够用（#228 调研结论照旧）：语料小（一个作用域几十到几百条），条目
 * 本身是提取后的高信号自包含句，query 与条目的用词重合度已经是很好的相关信号。
 * 向量检索是后续 PR（本地模型由记忆服务统一管），换的那天换 EntryScorer 这一个
 * 实现即可，门控 / 排序 / 预算不重写。
 *
 * 常驻（pinned）的语义换了：不再是逐条的 pinned 标记（那是摘抄的概念），而是
 * **user 层的偏好整体常驻**——用户跨工作区的偏好条数有限、每轮都可能相关，
 * 按时间取新的、受条数与字符预算限制（pickPinned）。
 */
import type { MemoryEntry, MemoryHit } from "../shared/memory.ts";

/** 关键词权重高于正文：关键词是提取时刻模型自己标的「这条是关于什么的」。 */
const KEYWORD_WEIGHT = 0.7;
const BODY_WEIGHT = 0.3;

/** 阈值门控：低于这个归一化分就不注入。「勉强沾边」的条目只会稀释 prompt。 */
const MIN_SCORE = 0.3;

/** 一次最多注入几条（不含常驻）。 */
const LIMIT = 5;

/** 词法命中注入的总字符预算（条目正文累加）。超了就不装——半句话比没有更难用。 */
const MAX_CHARS = 1500;

/** 时间衰减半衰期（天）。180 天：记忆是长期事实，「三个月前那条」只比今天的低一档。 */
const HALF_LIFE_DAYS = 180;

const DAY_MS = 86_400_000;

/** 常驻（user 层偏好）的条数上限：先到者先停（预算与条数双门，防止满屏短句）。 */
export const PINNED_LIMIT = 6;
/** 常驻注入的字符预算。头一条无条件装——常驻全是短偏好句，预算足够装下最新几条。 */
export const PINNED_MAX_CHARS = 1500;

/**
 * 一次查询的预处理结果。打分器收它而不是原始字符串——**将来换 embedding 时换的是
 * 「query 怎么变成向量」这一跳**，打分器的签名不用动（#228 的扩展位照留）。
 */
export interface MemoryQuery {
  text: string;
  tokens: ReadonlySet<string>;
}

/** 打分器：query × 条目 → 相关度（0..1，不含时间衰减）。词法实现是 lexicalScore。 */
export type EntryScorer = (query: MemoryQuery, entry: MemoryEntry) => number;

export interface RetrieveOptions {
  scorer?: EntryScorer;
  /** 「现在」（epoch ms）。测试固定它，别让衰减把用例变成漂移的。 */
  now?: number;
  limit?: number;
  maxChars?: number;
  threshold?: number;
}

/**
 * 分词：拉丁词（小写化，含数字 / 点 / 连字符——`electron-vite`、`0.1.6` 各算一个词）
 * + CJK bigram（中文没有词边界，bigram 是零依赖的近似分词；单字成段的收单字）。
 * #228 原样移植。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) tokens.push(word);
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

/** 轻度时间衰减：0..1，越老越低。未来的时间戳（时钟漂移）当作「就是今天」。 */
function decayOf(at: number, now: number): number {
  const ageDays = Math.max(0, now - at) / DAY_MS;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * 词法打分 = max(token 通道, 关键词子串通道)。#228 原样移植：
 *
 * token 通道：命中的 query token 里，关键词里的算 0.7、只在正文里的算 0.3，按
 * query token 总数归一化。CJK bigram 的局限（#228 真机实测）：自然中文问句切成
 * 「我的/的猫/猫叫/…」与条目关键词「猫」零交集，再被分母稀释——日常问句几乎
 * 永远过不了阈值。
 *
 * 关键词子串通道补的就是这个：关键词在 query **原文**里原样出现是刻意命中。首个
 * 命中给到阈值线 0.3，之后每个 +0.15，封顶 0.7。
 */
export function lexicalScore(query: MemoryQuery, entry: MemoryEntry): number {
  let tokenChannel = 0;
  if (query.tokens.size > 0) {
    const keywords = new Set(entry.keywords.flatMap(tokenize));
    const body = new Set(tokenize(entry.text));
    let weighted = 0;
    for (const token of query.tokens) {
      if (keywords.has(token)) weighted += KEYWORD_WEIGHT;
      if (body.has(token)) weighted += BODY_WEIGHT;
    }
    tokenChannel = weighted / query.tokens.size;
  }
  const haystack = query.text.toLowerCase();
  const substringHits = entry.keywords.filter((k) => {
    const needle = k.trim().toLowerCase();
    return needle !== "" && haystack.includes(needle);
  }).length;
  const keywordChannel =
    substringHits === 0 ? 0 : Math.min(KEYWORD_WEIGHT, MIN_SCORE + 0.15 * (substringHits - 1));
  return Math.max(tokenChannel, keywordChannel);
}

/**
 * 召回：打分 → 阈值门控 → 排序（分高者前，同分新者前）→ top N → 字符预算。
 * 空库 / 空 query / 无命中都返回 `[]`。muted / 常驻条目由调用方先滤掉。
 */
export function retrieveMemories(
  entries: readonly MemoryEntry[],
  query: string,
  options: RetrieveOptions = {},
): MemoryHit[] {
  const tokens = tokenize(query);
  if (entries.length === 0 || tokens.length === 0) return [];
  const now = options.now ?? Date.now();
  const threshold = options.threshold ?? MIN_SCORE;
  const limit = options.limit ?? LIMIT;
  const maxChars = options.maxChars ?? MAX_CHARS;
  const scorer = options.scorer ?? lexicalScore;
  const parsed: MemoryQuery = { text: query, tokens: new Set(tokens) };

  const ranked = entries
    .map((entry) => {
      // 门控看原始相关度，衰减只管排序与展示分——「老了一点」不该把压线命中挤出门外
      const relevance = scorer(parsed, entry);
      return { entry, relevance, score: relevance * decayOf(entry.at, now) };
    })
    .filter((hit) => hit.relevance >= threshold)
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at);

  const hits: MemoryHit[] = [];
  let used = 0;
  for (const candidate of ranked) {
    if (hits.length >= limit) break;
    const size = candidate.entry.text.length;
    // 装不下就跳过这条试下一条（短的也许还装得下）；一条都还没装时无条件收
    if (hits.length > 0 && used + size > maxChars) continue;
    used += size;
    hits.push({ entry: candidate.entry, score: candidate.score });
  }
  return hits;
}

/**
 * 覆盖度打分（偏好的冲突候选专用，#228 原样移植）：**这条旧记忆有多少出现在本轮
 * 内容里**。方向与 lexicalScore 相反——召回问「query 有多少落在条目里」（query 短、
 * 条目是靶子），冲突判问「条目有多少落在 query 里」（段内容长，条目短）。
 */
export function coverageScore(query: MemoryQuery, entry: MemoryEntry): number {
  const bodyTokens = new Set(tokenize(entry.text));
  const keywordTokens = new Set(entry.keywords.flatMap(tokenize));
  const bodyHit =
    bodyTokens.size === 0
      ? 0
      : [...bodyTokens].filter((token) => query.tokens.has(token)).length / bodyTokens.size;
  const keywordHit =
    keywordTokens.size === 0
      ? 0
      : [...keywordTokens].filter((token) => query.tokens.has(token)).length / keywordTokens.size;
  const haystack = query.text.toLowerCase();
  const substringHit = entry.keywords.some((keyword) => {
    const needle = keyword.trim().toLowerCase();
    return needle !== "" && haystack.includes(needle);
  });
  const blended = keywordTokens.size > 0 ? 0.6 * bodyHit + 0.4 * keywordHit : bodyHit;
  return Math.min(1, Math.max(blended, substringHit ? 1 : 0));
}

/**
 * 挑这轮要常驻的条目：**user 层的偏好**，按时间新者前，到字符预算或条数上限停。
 * 不打分——用户的跨工作区偏好（「回复用中文」「不要自动合并」）每轮都可能相关，
 * 词法打分反而会把措辞不沾边的偏好筛掉。
 */
export function pickPinned(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const pinned = entries
    .filter((entry) => entry.layer === "user" && entry.type === "preference")
    .sort((a, b) => b.at - a.at);
  const picked: MemoryEntry[] = [];
  let used = 0;
  for (const entry of pinned) {
    if (picked.length >= PINNED_LIMIT) break;
    if (picked.length > 0 && used + entry.text.length > PINNED_MAX_CHARS) continue;
    used += entry.text.length;
    picked.push(entry);
  }
  return picked;
}

/** 条目要不要参与召回：只有 active（muted = 用户关掉的，不再注入）。 */
export function isRecallable(entry: MemoryEntry): boolean {
  return (entry.status ?? "active") === "active";
}

/** 合并两层后按 id 去重（将来升层搬移若半路被杀会短暂同存两份，这里兜住）。 */
export function dedupeById(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const unique: MemoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

/**
 * 一次完整召回（recall 命令的核心）：合并 user 层 + 当前工作区层 → 常驻直通 +
 * 词法打分。常驻先装车，词法命中里已常驻的不再重复注入。
 */
export function recallHits(
  layers: { user: readonly MemoryEntry[]; scope: readonly MemoryEntry[] },
  query: string,
  now: number,
): MemoryHit[] {
  const active = dedupeById([...layers.user, ...layers.scope]).filter(isRecallable);
  const pinned = pickPinned(active);
  const pinnedIds = new Set(pinned.map((entry) => entry.id));
  const lexical = retrieveMemories(
    active.filter((entry) => !pinnedIds.has(entry.id)),
    query,
    { now },
  );
  return [
    ...pinned.map((entry): MemoryHit => ({ entry, score: 1, pinned: true })),
    ...lexical,
  ];
}
