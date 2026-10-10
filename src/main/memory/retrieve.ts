/**
 * 词法召回（memory v1）——**关键词重叠 + 正文 token 重叠 + 轻度时间衰减**，
 * 出门过三道闸：阈值门控（低分不返回）→ top N → 总字符预算。
 *
 * 为什么够用（三个参考系统的调研结论，shared/memory.ts 头部）：语料小（一个作用域
 * 几十到几百条），且条目本身是蒸馏后的高信号陈述句——query 与条目的用词重合度
 * 已经是很好的相关信号。向量检索**刻意缓办**：多一个 embedding 依赖、多一条
 * 「模型下载失败」的通路，而收益要等语料长到词法失效那天才出现。
 * ponytail: 真要换的那天，换 `EntryScorer` 这一个实现即可，门控 / 排序 / 预算不重写。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import type { MemoryEntry, MemoryHit } from "../../shared/memory.ts";

/** 关键词权重高于正文：关键词是蒸馏时刻模型自己标的「这条是关于什么的」，比正文里偶然出现的词更准。 */
const KEYWORD_WEIGHT = 0.7;
const BODY_WEIGHT = 0.3;

/** 阈值门控：低于这个归一化分就不注入。「勉强沾边」的条目只会稀释 prompt。 */
const MIN_SCORE = 0.3;

/** 一次最多注入几条。 */
const LIMIT = 5;

/** 注入总字符预算（条目正文累加）。超了就不装——半句话比没有更难用。 */
const MAX_CHARS = 1500;

/** 时间衰减半衰期（天）。180 天：记忆是长期事实，「三个月前那条」只比「今天的」低一档，不是判负。 */
const HALF_LIFE_DAYS = 180;

const DAY_MS = 86_400_000;

/**
 * 一次查询的预处理结果。打分器收它而不是原始字符串——**未来换 embedding 时
 * 换的是「query 怎么变成向量」这一跳**，打分器的签名不用动。
 */
export interface MemoryQuery {
  text: string;
  tokens: ReadonlySet<string>;
}

/**
 * 打分器：query × 条目 → 相关度（0..1，不含时间衰减——衰减与「词法还是向量」无关，
 * 由 retrieveMemories 统一乘上去）。
 *
 * **扩展位**：将来上 embedding 时写一个 `(query, entry) => cosine(...)` 传进
 * `RetrieveOptions.scorer` 即可，门控 / 排序 / 预算一行不改。
 * ponytail: 不实现向量检索（见文件头）。
 */
export type EntryScorer = (query: MemoryQuery, entry: MemoryEntry) => number;

export interface RetrieveOptions {
  /** 打分器，默认词法（lexicalScore）。 */
  scorer?: EntryScorer;
  /** 「现在」（epoch ms）。测试固定它，别让衰减把用例变成漂移的。 */
  now?: number;
  /** 最多几条，默认 5。 */
  limit?: number;
  /** 总字符预算，默认 1500。 */
  maxChars?: number;
  /** 阈值，默认 0.3。 */
  threshold?: number;
}

/**
 * 分词：拉丁词（小写化，含数字 / 点 / 连字符——`electron-vite`、`0.1.6` 各算一个词）
 * + CJK bigram（中文没有词边界，bigram 是零依赖的近似分词；单字成段的（「库」）收单字）。
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
function decayOf(timestamp: number, now: number): number {
  const ageDays = Math.max(0, now - timestamp) / DAY_MS;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * 词法打分：命中的 query token 里，关键词里的算 0.7、只在正文里的算 0.3，
 * 按 query token 总数归一化。所以「关键词全中」= 0.7+，「正文全中」= 0.3+，
 * 一个都不中 = 0（过不了阈值门控）。
 */
export function lexicalScore(query: MemoryQuery, entry: MemoryEntry): number {
  if (query.tokens.size === 0) return 0;
  const keywords = new Set(entry.keywords.flatMap(tokenize));
  const body = new Set(tokenize(entry.text));
  let weighted = 0;
  for (const token of query.tokens) {
    if (keywords.has(token)) weighted += KEYWORD_WEIGHT;
    if (body.has(token)) weighted += BODY_WEIGHT;
  }
  return weighted / query.tokens.size;
}

/**
 * 召回：打分 → 阈值门控 → 排序（分高者前，同分新者前）→ top N → 字符预算。
 *
 * 空库 / 空 query（纯标点，分不出 token）/ 无命中都返回 `[]`——
 * 「没东西可注入」不是错误（契约：MemoryRetrieveOutcome 的 ok 双分支）。
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
    .map((entry) => ({ entry, score: scorer(parsed, entry) * decayOf(entry.timestamp, now) }))
    .filter((hit) => hit.score >= threshold)
    .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp);

  const hits: MemoryHit[] = [];
  let used = 0;
  for (const candidate of ranked) {
    if (hits.length >= limit) break;
    const size = candidate.entry.text.length;
    // 装不下就跳过这条试下一条（短的也许还装得下）；一条都还没装时无条件收——
    // 最高分那条再长，也比空手强
    if (hits.length > 0 && used + size > maxChars) continue;
    used += size;
    hits.push({ entry: candidate.entry, score: candidate.score });
  }
  return hits;
}
