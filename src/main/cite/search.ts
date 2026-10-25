/**
 * 在线文献检索 —— Crossref + arXiv，**只在用户点「查找」时发生**。
 *
 * 三个决定：
 * - **不设 API key、不加配置项**：两个接口都是公开的（Crossref 的记录本来就开放，
 *   arXiv 的 Atom 接口默认限速），要用户先申请 key 才能查一条文献，是把门槛放在了
 *   最不需要它的地方。限流按「一次查询最多两次请求」自己控，撞上 429 如实报出来。
 * - **8 秒超时、10 分钟内存缓存**：用户在面板里反复改一个字重查时，同一条查询不该
 *   每次都打网络；缓存只存成功结果（失败要能立刻重试），进程退出即消失——这是
 *   会话级缓存，不是数据库。
 * - **解析与网络分开**：`parseCrossrefWorks` / `parseArxivFeed` 是纯函数（有测试），
 *   网络用注入的 `request` 换掉，于是「缺字段 / HTML 实体 / 接口挂了」都能离线测。
 *
 * 输入自己认：标题、DOI（`10.…`）、arXiv 编号（`2401.12345`）走三套不同的 URL，
 * 因为「查一条已知编号的文献」与「按标题找」用的不是同一个端点——先搜再筛会把
 * 精确输入变成碰运气。
 *
 * DOI 里的 `10.48550/arXiv.*` 是 arXiv 自己注册的 DOI（DataCite，不在 Crossref 里），
 * 直接丢给 Crossref 只会 404，所以先认成 arXiv 编号。
 */
import type {
  CiteCandidate,
  CiteSearchFailure,
  CiteSearchOutcome,
} from "../../shared/cite.ts";

/** 一次查询的墙钟上限：8 秒还拿不到，用户已经以为它卡死了 */
const TIMEOUT_MS = 8000;

/** 缓存活多久（同一条查询在面板里反复触发时省下网络往返） */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 缓存条数上限：一次会话里查几十条文献是常态，但不能无限攒 */
const MAX_CACHE_ENTRIES = 50;

/** 每个来源最多取几条：面板一屏放得下，也不必翻页 */
const PER_SOURCE = 5;

/** 失败的那个分支：几个出口（状态码 / 网络 / 解析）都产出这一种形状 */
type SearchFailure = { ok: false; reason: CiteSearchFailure; detail: string };

/** 一次 HTTP 的结局：只要状态码与文本，JSON / XML 的解析归各自的解析器 */
export interface CiteHttpResponse {
  status: number;
  body: string;
}

/** 网络出口（测试注入）。`signal` 由调用方给（8 秒超时） */
export type CiteHttpRequest = (url: string, signal: AbortSignal) => Promise<CiteHttpResponse>;

export interface CiteSearchDeps {
  request?: CiteHttpRequest;
  now?: () => number;
}

/** 默认出口：Node 24 的全局 fetch（不新增依赖）。UA 写清楚，公共接口的礼貌 */
async function fetchText(url: string, signal: AbortSignal): Promise<CiteHttpResponse> {
  const response = await fetch(url, {
    signal,
    headers: {
      accept: "application/json, application/atom+xml;q=0.9, */*;q=0.1",
      "user-agent": "orbita/0.1 (local desktop agent; cite search)",
    },
  });
  return { status: response.status, body: await response.text() };
}

/** 查询草稿 → 一次 URL 计划。三种输入三种端点，不混着猜 */
type QueryPlan =
  | { kind: "arxiv"; id: string }
  | { kind: "doi"; doi: string }
  | { kind: "text"; text: string };

const ARXIV_NEW = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const ARXIV_OLD = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/;
const DOI_SHAPE = /^10\.\d{4,9}\/\S+$/;
/** arXiv 自己注册的 DOI 前缀（大小写不敏感）：`10.48550/arXiv.1706.03762` */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

/**
 * 识别输入。`https://doi.org/…` / `doi:` / `arXiv:` 前缀都剥掉——用户从浏览器地址栏
 * 复制来的就是这样，让他为了查一条文献先删前缀是界面的失职。
 */
export function planQuery(raw: string): QueryPlan {
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/^arxiv:\s*/i, "")
    .trim();
  const arxivDoi = ARXIV_DOI.exec(trimmed);
  if (arxivDoi !== null) return { kind: "arxiv", id: stripArxivVersion(arxivDoi[1] ?? "") };
  if (ARXIV_NEW.test(trimmed) || ARXIV_OLD.test(trimmed)) {
    return { kind: "arxiv", id: stripArxivVersion(trimmed) };
  }
  if (DOI_SHAPE.test(trimmed)) return { kind: "doi", doi: trimmed };
  return { kind: "text", text: trimmed };
}

/** `1706.03762v7` → `1706.03762`：版本号对「是哪一篇」没有影响，带上反而查不到 entry */
function stripArxivVersion(id: string): string {
  return id.replace(/v\d+$/i, "");
}

interface CacheSlot {
  at: number;
  results: CiteCandidate[];
}

/** 进程内缓存：只存成功的结果，失败让用户能立刻重试 */
const cache = new Map<string, CacheSlot>();

/**
 * 查一条文献。空查询直接拒（不花掉一次网络）；其余按 `planQuery` 分派。
 *
 * 失败是**分类过的**（超时 / 离线 / 限流 / 没找到 / 其它），因为面板要说的不是
 * `TypeError: fetch failed`，而是「连不上网络，检查代理后再试」。
 */
export async function searchCite(rawQuery: string, deps: CiteSearchDeps = {}): Promise<CiteSearchOutcome> {
  const query = rawQuery.trim();
  if (query === "") return { ok: false, reason: "empty-query", detail: "" };
  const plan = planQuery(query);
  const key = `${plan.kind}:${query.toLowerCase()}`;
  const now = deps.now?.() ?? Date.now();

  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return { ok: true, results: hit.results };

  const outcome = await run(plan, deps.request ?? fetchText);
  if (outcome.ok) remember(key, now, outcome.results);
  return outcome;
}

function remember(key: string, at: number, results: CiteCandidate[]): void {
  cache.delete(key);
  cache.set(key, { at, results });
  // 先删最早插入的那条（Map 保序）：满了就丢最旧的
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

async function run(plan: QueryPlan, request: CiteHttpRequest): Promise<CiteSearchOutcome> {
  if (plan.kind === "arxiv") return byArxivId(plan.id, request);
  if (plan.kind === "doi") return byDoi(plan.doi, request);
  return byText(plan.text, request);
}

/** DOI 直达：Crossref 的 `/works/{doi}` 只回一条，比搜一遍再筛准 */
async function byDoi(doi: string, request: CiteHttpRequest): Promise<CiteSearchOutcome> {
  let response: CiteHttpResponse;
  try {
    response = await withTimeout(request, `https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  } catch (cause) {
    return failed(cause);
  }
  if (response.status === 404) return { ok: false, reason: "not-found", detail: doi };
  const statusFailure = statusProblem(response.status);
  if (statusFailure !== null) return statusFailure;
  const parsed = parseJson(response.body);
  const candidate = crossrefCandidate(record(parsed)?.message);
  return candidate === null
    ? { ok: false, reason: "not-found", detail: doi }
    : { ok: true, results: [candidate] };
}

/** arXiv 编号直达：`id_list` 一次取回一条 */
async function byArxivId(id: string, request: CiteHttpRequest): Promise<CiteSearchOutcome> {
  let response: CiteHttpResponse;
  try {
    response = await withTimeout(
      request,
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
    );
  } catch (cause) {
    return failed(cause);
  }
  const statusFailure = statusProblem(response.status);
  if (statusFailure !== null) return statusFailure;
  const results = parseArxivFeed(response.body);
  return results.length === 0
    ? { ok: false, reason: "not-found", detail: id }
    : { ok: true, results };
}

/**
 * 标题检索：两个来源**并发**跑，一个挂了用另一个的结果（arXiv 抽风不该让整次查找
 * 失败）；两个都挂才报错，报的是先失败的那个原因。
 */
async function byText(text: string, request: CiteHttpRequest): Promise<CiteSearchOutcome> {
  const crossrefUrl = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(text)}&rows=${PER_SOURCE}`;
  const arxivUrl = `https://export.arxiv.org/api/query?${arxivSearchQuery(text)}&max_results=${PER_SOURCE}&sortBy=relevance`;

  const [crossref, arxiv] = await Promise.allSettled([
    withTimeout(request, crossrefUrl).then((response) => {
      const statusFailure = statusProblem(response.status);
      if (statusFailure !== null) throw new HttpStatusError(statusFailure);
      return parseCrossrefWorks(response.body);
    }),
    withTimeout(request, arxivUrl).then((response) => {
      const statusFailure = statusProblem(response.status);
      if (statusFailure !== null) throw new HttpStatusError(statusFailure);
      return parseArxivFeed(response.body);
    }),
  ]);

  const results: CiteCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: CiteCandidate): void => {
    const fingerprint = candidate.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (fingerprint !== "" && seen.has(fingerprint)) return;
    seen.add(fingerprint);
    results.push(candidate);
  };
  if (crossref.status === "fulfilled") crossref.value.forEach(push);
  if (arxiv.status === "fulfilled") arxiv.value.forEach(push);

  if (results.length > 0) return { ok: true, results };
  // 都没结果：至少有一个来源答了「就是没有」，这次查询是成功的空结果
  if (crossref.status === "fulfilled" || arxiv.status === "fulfilled") return { ok: true, results: [] };
  return failed(crossref.status === "rejected" ? crossref.reason : arxiv.reason);
}

/** 带 8 秒超时地发一次请求。`AbortSignal.timeout` 的报错名是 TimeoutError */
async function withTimeout(request: CiteHttpRequest, url: string): Promise<CiteHttpResponse> {
  return request(url, AbortSignal.timeout(TIMEOUT_MS));
}

/** 非 2xx 的统一分类。2xx 返回 null */
function statusProblem(status: number): SearchFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return { ok: false, reason: "rate-limited", detail: "429" };
  if (status === 404) return { ok: false, reason: "not-found", detail: "404" };
  return { ok: false, reason: "failed", detail: `HTTP ${status}` };
}

/** `byText` 里把 HTTP 状态失败变成 rejection，与网络失败走同一条出口 */
class HttpStatusError extends Error {
  /** 原始分类：这一层只负责把它运过 Promise.allSettled，不重新解释 */
  readonly failure: SearchFailure;

  constructor(outcome: SearchFailure) {
    super(outcome.detail);
    this.name = "HttpStatusError";
    this.failure = outcome;
  }
}

/** 失败分类：面板要的是「该做什么」，不是网络栈原文 */
function failed(cause: unknown): SearchFailure {
  if (cause instanceof HttpStatusError) return cause.failure;
  const reason = errorReason(cause);
  return { ok: false, reason, detail: errorText(cause) };
}

const OFFLINE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function errorReason(cause: unknown): CiteSearchFailure {
  if (!(cause instanceof Error)) return "failed";
  if (cause.name === "TimeoutError" || cause.name === "AbortError") return "timeout";
  const code = errorCode(cause);
  if (code !== null && OFFLINE_CODES.has(code)) return "offline";
  return "failed";
}

/** Node 的 fetch 把系统错误藏在 `cause` 里（可能两层），逐层找 `code` */
function errorCode(error: Error, depth = 0): string | null {
  if ("code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (depth >= 3) return null;
  const nested = (error as Error & { cause?: unknown }).cause;
  return nested instanceof Error ? errorCode(nested, depth + 1) : null;
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) {
    const code = errorCode(cause);
    // 首行足够：Node 的 fetch 消息后面跟着一大段内部堆栈
    return code === null ? (cause.message.split("\n")[0] ?? cause.message) : code;
  }
  return String(cause);
}

/* ------------------------------ Crossref ------------------------------ */

/**
 * Crossref `works` 的 JSON → 候选。`message.items` 是数组；单条 `/works/{doi}`
 * 是 `message` 本身。两者都接受（用 `parseCrossrefWorks` 时传整份响应）。
 */
export function parseCrossrefWorks(body: string): CiteCandidate[] {
  const root = parseJson(body);
  const message = record(root)?.message;
  const items = record(message)?.items;
  if (!Array.isArray(items)) {
    // 单条响应：`message` 本身就是一条 work
    const single = crossrefCandidate(message);
    return single === null ? [] : [single];
  }
  const out: CiteCandidate[] = [];
  for (const item of items) {
    const candidate = crossrefCandidate(item);
    if (candidate !== null) out.push(candidate);
  }
  return out;
}

/** 一条 Crossref work → 候选；标题都取不到就当这条没解析出来（不产出空标题条目） */
function crossrefCandidate(value: unknown): CiteCandidate | null {
  const item = record(value);
  if (item === null) return null;
  const title = cleanTitle(firstString(item.title));
  if (title === "") return null;

  const authors = authorList(item.author).map(({ given, family }) =>
    family === "" ? given : given === "" ? family : `${given} ${family}`,
  );
  return {
    source: "crossref",
    title,
    authors,
    year: crossrefYear(item),
    venue: cleanTitle(firstString(item["container-title"])) || null,
    doi: nonEmpty(item.DOI),
    arxivId: null,
    type: item.type === "proceedings-article" ? "inproceedings" : "article",
    volume: nonEmpty(item.volume),
    pages: nonEmpty(item.page),
    primaryClass: null,
  };
}

/** 年份：`issued.date-parts[0][0]`，没有再退到 print / online / published 几个同形字段 */
function crossrefYear(item: Record<string, unknown>): string | null {
  for (const field of ["issued", "published-print", "published-online", "published"]) {
    const dateParts = record(item[field])?.["date-parts"];
    const first = Array.isArray(dateParts) ? dateParts[0] : undefined;
    if (!Array.isArray(first) || first.length === 0) continue;
    const year: unknown = first[0];
    if (typeof year === "number") return String(year);
    if (typeof year === "string" && /^\d{4}$/.test(year)) return year;
  }
  return null;
}

/* -------------------------------- arXiv -------------------------------- */

/**
 * arXiv Atom feed → 候选。手写 XML 里的东西只取我们写进 .bib 的那几项：
 * 标题、作者、年份、编号、primary category、DOI。`<summary>` 一律不解析（几千字
 * 摘要只是为了显示一列结果，没有必要）。
 */
export function parseArxivFeed(body: string): CiteCandidate[] {
  const out: CiteCandidate[] = [];
  for (const block of splitEntries(body)) {
    const id = arxivIdOf(tagText(block, "id"));
    const title = cleanTitle(tagText(block, "title"));
    if (id === null || title === "") continue;
    const authors = [...block.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)]
      .map((match) => cleanTitle(tagText(match[1] ?? "", "name")))
      .filter((name) => name !== "");
    out.push({
      source: "arxiv",
      title,
      authors,
      year: arxivYear(tagText(block, "published")),
      venue: "arXiv",
      doi: nonEmpty(tagText(block, "doi")) ?? nonEmpty(tagText(block, "arxiv:doi")),
      arxivId: id,
      type: "misc",
      volume: null,
      pages: null,
      primaryClass: arxivPrimaryClass(block),
    });
  }
  return out;
}

/** 每个 `<entry>` 一块；没有 entry 时是空数组（接口报错时回的是 `<feed>` 带一条 error） */
function splitEntries(body: string): string[] {
  return [...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((match) => match[1] ?? "");
}

/** `<id>http://arxiv.org/abs/1706.03762v7</id>` → `1706.03762` */
function arxivIdOf(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  const abs = /\/abs\/([^?#\s]+)$/.exec(text);
  const id = abs === null ? text : (abs[1] ?? "");
  return stripArxivVersion(id) || null;
}

/** `<published>2017-06-12T17:57:16Z</published>` → `2017` */
function arxivYear(raw: string): string | null {
  return /\d{4}/.exec(raw)?.[0] ?? null;
}

function arxivPrimaryClass(block: string): string | null {
  const primary = /<arxiv:primary_category\b[^>]*\bterm="([^"]+)"/.exec(block);
  if (primary !== null) return primary[1] ?? null;
  const category = /<category\b[^>]*\bterm="([^"]+)"/.exec(block);
  return category?.[1] ?? null;
}

/** 取一个标签的文本（不嵌套同名标签；CDATA 也收） */
function tagText(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)</${escaped}>`, "i").exec(block);
  if (match === null) return "";
  const inner = match[1] ?? "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return (cdata === null ? inner : (cdata[1] ?? "")).trim();
}

/** arXiv 的 `search_query`：每个词一个 `all:` 条件，用 AND 串起来（官方语法） */
function arxivSearchQuery(text: string): string {
  const words = text.split(/\s+/).filter((word) => word !== "").slice(0, 10);
  const clauses = words.map((word) => `all:${encodeURIComponent(word)}`);
  return `search_query=${clauses.join("+AND+")}`;
}

/* ------------------------------- 公共小件 ------------------------------- */

/**
 * 标题 / 人名 / 期刊名的显示形：HTML 实体还原、标签剥掉、空白折叠。
 * Crossref 的标题里真的带 `<i>` / `<sub>` 与 `&amp;`（接口给了标记，不是纯文本）。
 */
export function cleanTitle(raw: string): string {
  return decodeEntities(raw)
    .replace(/<[^>]*>/g, "")
    // 折叠所有空白（换行在 Atom 的标题里会为了排版插在词中间）
    .replace(/\s+/g, " ")
    .trim();
}

/** 只认会出现在文献元数据里的那几个实体；其余原样留着（宁可显示 `&foo;` 也不吞字） */
export function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  minus: "−",
};

/** Crossref 的 author 数组：`{ given, family }`；只有 `name` 的机构作者也算一个人 */
function authorList(value: unknown): { given: string; family: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { given: string; family: string }[] = [];
  for (const entry of value) {
    const author = record(entry);
    if (author === null) continue;
    const family = cleanTitle(firstString(author.family));
    const given = cleanTitle(firstString(author.given));
    const name = cleanTitle(firstString(author.name));
    if (family === "" && given === "" && name === "") continue;
    out.push({ given: given === "" ? name : given, family });
  }
  return out;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Crossref 的字段有字符串 / 字符串数组两种写法；空串按「没有」算 */
function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim() !== "");
    return typeof first === "string" ? first : "";
  }
  return "";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
