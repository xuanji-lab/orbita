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

/** 一次最多注入几条（不含常驻）。向量融合路径同一个数。 */
export const RECALL_LIMIT = 5;

/** 命中注入的总字符预算（条目正文累加）。超了就不装——半句话比没有更难用。 */
export const RECALL_MAX_CHARS = 1500;

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
  /** 已经装车的条目（常驻）：与它们同源复述的命中不再占名额 */
  taken?: readonly MemoryEntry[];
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
 * 词法打分 = max(token 通道, 关键词子串通道, 关键词 bigram 覆盖通道)。
 *
 * token 通道：命中的 query token 里，关键词里的算 0.7、只在正文里的算 0.3，按
 * query token 总数归一化。CJK bigram 的局限（#228 真机实测）：自然中文问句切成
 * 「我的/的猫/猫叫/…」与条目关键词「猫」零交集，再被分母稀释——日常问句几乎
 * 永远过不了阈值。
 *
 * 关键词子串通道补的是「关键词在 query 原文里原样出现」：首个命中给到阈值线
 * 0.3，之后每个 +0.15，封顶 0.7。它只认整词——关键词是复合词（「依赖管理」）
 * 而 query 只说到其中一部分（「帮我装依赖」，2026-10-29 真机冒烟实测）时擦肩
 * 而过。
 *
 * 关键词 bigram 覆盖通道是子串通道的容错版：按关键词自己的 bigram 算 query 对
 * 它的覆盖度，够 1/3（复合词里撞上一个实词 bigram）就给到阈值线——刻意相关
 * 而不是偶然重叠，误伤由 top5 + 字符预算兑底。
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
  let keywordChannel =
    substringHits === 0 ? 0 : Math.min(KEYWORD_WEIGHT, MIN_SCORE + 0.15 * (substringHits - 1));
  let bigramCoverage = 0;
  for (const keyword of entry.keywords) {
    const parts = tokenize(keyword);
    if (parts.length === 0) continue;
    const hit = parts.filter((token) => query.tokens.has(token)).length / parts.length;
    if (hit > bigramCoverage) bigramCoverage = hit;
  }
  if (bigramCoverage >= 1 / 3) keywordChannel = Math.max(keywordChannel, MIN_SCORE);
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
  const limit = options.limit ?? RECALL_LIMIT;
  const maxChars = options.maxChars ?? RECALL_MAX_CHARS;
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

  return selectHits(
    ranked.map((candidate): MemoryHit => ({ entry: candidate.entry, score: candidate.score })),
    { limit, maxChars, taken: options.taken ?? [] },
  );
}

/**
 * 同源复述判定的文字重叠门槛（Jaccard = 交集 / 并集）。2026-10-29 隔离实例 memui 的
 * 8 段真实对话，用改写后的提取提示词跑出的条目逐对人工标注：同一个意思换个说法
 * （事实 / 偏好 / 经验三次提取各写一遍）Jaccard 落在 0.27–0.57；层次真不同的同源对
 * （「写作前喝不加糖的手冲咖啡」对「安排习惯时排除用户说有负面影响的东西」）都 ≤ 0.17。
 * 不用重叠系数（交集 / 较小集合）：抽象后的经验句更长、又把具体例子包在里面，
 * 重叠系数会把它和出处事实判成复述（实测 0.38–0.54，与真复述的 0.5–0.9 搅在一起）。
 */
const RESTATEMENT_JACCARD = 0.25;

function tokenBag(entry: MemoryEntry): Set<string> {
  return new Set([...tokenize(entry.text), ...entry.keywords.flatMap((keyword) => tokenize(keyword))]);
}

/**
 * 两条记忆是不是同一来源的复述：**同一事件段、支撑轮号有交集，且文字大量重叠**。
 *
 * 为什么按来源而不是只按文字相似：QUMem 每段对话按三类各提取一次，同一句话常被
 * 写成事实 + 偏好 + 经验三条（实测召回的 5 个名额里 3 个是同一件事）。原文的兜底
 * 在检索端——合并去重，且同一段原文只放一次；Mandol 的 MMR 也按「来源重叠」算冗余。
 * 只看来源会误伤（一句话里讲了两件事；或经验把事实抽象了一层——QUMem 明说同一段
 * 交互可以支撑不同抽象层次的记忆），所以再加文字门槛。
 * 手动添加的条目没有事件段（episodeId 为空），永远不算同源。
 */
export function isRestatement(a: MemoryEntry, b: MemoryEntry): boolean {
  if (a.episodeId === "" || a.episodeId !== b.episodeId) return false;
  if (!a.turns.some((turn) => b.turns.includes(turn))) return false;
  const left = tokenBag(a);
  const right = tokenBag(b);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union > 0 && shared / union >= RESTATEMENT_JACCARD;
}

/**
 * 按名次装车：top N + 字符预算 + 同源复述只留名次最高的一条（不占名额，后面的补上）。
 * 词法召回与向量融合两条路共用——名额怎么分只在这里定一次。
 */
export function selectHits(
  ranked: readonly MemoryHit[],
  options: { limit: number; maxChars: number; taken: readonly MemoryEntry[] },
): MemoryHit[] {
  const hits: MemoryHit[] = [];
  let used = 0;
  for (const candidate of ranked) {
    if (hits.length >= options.limit) break;
    if (options.taken.some((entry) => isRestatement(entry, candidate.entry))) continue;
    if (hits.some((hit) => isRestatement(hit.entry, candidate.entry))) continue;
    const size = candidate.entry.text.length;
    // 装不下就跳过这条试下一条（短的也许还装得下）；一条都还没装时无条件收
    if (hits.length > 0 && used + size > options.maxChars) continue;
    used += size;
    hits.push(candidate);
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
    // 常驻也会有同源复述（同一段对话提取的偏好一起升到所有工作区）：只留最新那条
    if (picked.some((kept) => isRestatement(kept, entry))) continue;
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
    { now, taken: pinned },
  );
  return [
    ...pinned.map((entry): MemoryHit => ({ entry, score: 1, pinned: true })),
    ...lexical,
  ];
}

/* ---------- agent 的 memory_search：排序，不门控 ---------- */

/**
 * 条目一侧的检索单位：tokenize 的结果（拉丁词 + CJK bigram）再加上每个 CJK 单字——查询里
 * 单独成段的字（「猫 宠物」里的「猫」）要能对上条目里词中的字（「橘猫」）。查询一侧只用
 * tokenize：连续的中文按 bigram 切，「量子计算」不会拆出一个「子」去撞「团子」。
 */
function entrySearchUnits(entry: MemoryEntry): Set<string> {
  const text = `${entry.text} ${entry.keywords.join(" ")}`;
  return new Set([...tokenize(text), ...(text.match(/[\u4e00-\u9fff]/g) ?? [])]);
}

/** memory_search 的最低分：低于它的条目一个有区分度的字都没对上，或只沾了边。 */
const SEARCH_MIN_SCORE = 0.3;

/**
 * agent 主动检索（memory_search）的排序。与轮前召回的分工不同：召回是**每轮自动**注入，
 * 宁缺毋滥，要门控；检索是 agent **有意**去找某一条（用户在纠正它），漏了就改不成，
 * 多回几条由模型自己挑。
 *
 * 为什么不直接用 lexicalScore：它以查询的全部 token 为分母，agent 的检索句里总有库里根本
 * 没有的词——「猫的名字 团子」切成「猫的 / 的名 / 名字 / 团子」，与「用户养了一只叫团子的
 * 橘猫」只对上「团子」，0.3÷4 过不了门槛（2026-10-29 实例 memalign 实测两次检索都空手）。
 * 这里改成**按区分度加权、只数库里出现过的单位**：
 * - 单位见 entrySearchUnits（查询侧是 tokenize）；
 * - 每个单位按 IDF 加权：「用户」这类每条都有的单位权重低，对上了也不算数；
 * - 一个条目的得分 = 它对上的单位的 IDF 之和 ÷ 查询里所有「库里出现过的」单位的 IDF 之和
 *   （库里根本没有的词不进分母：「宠物」没人提过，不该稀释「猫」）；
 * - 与 coverageScore（条目有多少落在检索句里）取最大，过 SEARCH_MIN_SCORE，按分排、取前 limit。
 *   **不掺 lexicalScore**：它的关键词 bigram 通道一个字沾边就给到 0.3（实例里「习惯」二字
 *   把汇报偏好捞进了咖啡的检索结果），召回门控可以靠它兜底，检索排序不行。
 */
export function searchMemories(
  entries: readonly MemoryEntry[],
  query: string,
  options: { limit: number; now: number },
): MemoryHit[] {
  const queryUnits = new Set(tokenize(query));
  if (entries.length === 0 || queryUnits.size === 0) return [];
  const parsed: MemoryQuery = { text: query, tokens: queryUnits };
  const entryUnits = entries.map(entrySearchUnits);
  const total = entries.length;
  const idf = new Map<string, number>();
  for (const unit of queryUnits) {
    const df = entryUnits.filter((units) => units.has(unit)).length;
    if (df === 0) continue; // 库里没有的字不进分母
    idf.set(unit, Math.log(1 + total / df));
  }
  const denominator = [...idf.values()].reduce((sum, value) => sum + value, 0);
  return entries
    .map((entry, index) => {
      let matched = 0;
      for (const [unit, weight] of idf) if (entryUnits[index]!.has(unit)) matched += weight;
      const charScore = denominator === 0 ? 0 : matched / denominator;
      const relevance = Math.max(charScore, coverageScore(parsed, entry));
      return { entry, relevance, score: relevance * decayOf(entry.at, options.now) };
    })
    .filter((hit) => hit.relevance >= SEARCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
    .slice(0, options.limit)
    .map((hit): MemoryHit => ({ entry: hit.entry, score: hit.score }));
}
