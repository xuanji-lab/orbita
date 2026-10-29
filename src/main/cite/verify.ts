/**
 * 引文核验（`cite:verify`）—— 把项目 .bib 里的条目拿去 Crossref / arXiv 对一遍。
 *
 * **为什么要做**：agent 会往 .bib 里写条目（在线检索面板也会），而一条编错的 DOI 在
 * 编译期完全看不出来——它只会在投稿时变成「参考文献指向另一篇论文」。这里按
 * DOI → arXiv 号 → 标题的顺序查，查到的记录标题对不上时单独标 `mismatch`（比
 * 「查不到」危险得多：查不到通常只是预印本没注册 DOI，查到另一篇意味着编号粘错了）。
 *
 * 三个纪律：
 * - **只在用户点「核验」时联网**（与在线检索同一条）：没有启动预取、没有后台轮询。
 *   复用 `searchCite` 的 8 秒超时、失败分类与 10 分钟缓存。
 * - **只查白名单内项目里的条目**：请求只带「根 + 当前文件」，条目由主进程自己重读，
 *   renderer 无法把任意字符串当查询打给公共 API。
 * - **上限 `CITE_VERIFY_LIMIT`**：每条 1–2 次公共接口请求，几百条会被限流；一次最多
 *   八条、三路并发，剩余的说清楚「没查」而不是假装核验过。
 */
import {
  CITE_VERIFY_LIMIT,
  type CiteEntry,
  type CiteLibrary,
  type CiteSearchOutcome,
  type CiteVerification,
  type CiteVerifyIdentifier,
} from "../../shared/cite.ts";
import { searchCite } from "./search.ts";

/** 核验依赖：测试注入 `search`（不打网络）；默认就是在线检索那一条通道 */
export interface CiteVerifyDeps {
  search?: (query: string) => Promise<CiteSearchOutcome>;
}

/** 同时发出去的核验数：公共接口的礼貌上限，也避免一次点下去挂十个请求 */
const CONCURRENCY = 3;

/** 标题归一：去 LaTeX 命令、标点、空白、大小写——「Sparse Attention: A Survey」与
 * 「Sparse attention — a survey」算同一篇 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\\[a-z]+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 两个标题是不是同一篇：归一后**相等**，或一方是另一方的副标题（包含关系）。
 *
 * 为什么用包含关系而不是「相似度」：标题的常见差异就是副标题（`Attention Is All
 * You Need` vs `Attention Is All You Need: A Retrospective`）与大小写 / 标点，
 * 包含关系正好覆盖这两类，而且不会因为词序不同把两篇不相干的论文判成同一篇。
 * 任一侧缺标题时**不诬告**（视为对得上）：没有标题可比，就没有「属于另一篇」的证据。
 */
export function titlesAgree(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return true;
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (a === "" || b === "") return true;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.includes(shorter);
}

/** 用哪个标识查：DOI > arXiv 号 > 标题。都没有时 null（无从查起） */
export function verifyIdentifierOf(entry: CiteEntry): CiteVerifyIdentifier | null {
  if (entry.doi !== null && entry.doi.trim() !== "") return { kind: "doi", value: entry.doi.trim() };
  if (entry.eprint !== null && entry.eprint.trim() !== "") return { kind: "arxiv", value: entry.eprint.trim() };
  if (entry.title !== null && entry.title.trim() !== "") return { kind: "title", value: entry.title.trim() };
  return null;
}

/** 一次核验的结局（不含全局失败：那是 IPC 层的事） */
export interface VerifyBatch {
  results: CiteVerification[];
  /** 项目里一共有多少条可核验（有 DOI / arXiv 号 / 标题）的条目 */
  total: number;
}

/**
 * 核验一批条目。`keys` 缺席 = 项目里所有可核验的条目（受上限限制）；
 * 给了 keys 就只查这些（界面上「只核验未核验的那几条」靠它）。
 */
export async function verifyCiteEntries(
  library: CiteLibrary,
  keys: readonly string[] | null,
  deps: CiteVerifyDeps = {},
): Promise<VerifyBatch> {
  const search = deps.search ?? ((query: string) => searchCite(query));
  const verifiable = library.entries
    .map((entry) => ({ entry, identifier: verifyIdentifierOf(entry) }))
    .filter((item): item is { entry: CiteEntry; identifier: CiteVerifyIdentifier } => item.identifier !== null);
  const wanted =
    keys === null ? verifiable : verifiable.filter((item) => keys.includes(item.entry.key));
  const batch = wanted.slice(0, CITE_VERIFY_LIMIT);

  const results: CiteVerification[] = [];
  for (let at = 0; at < batch.length; at += CONCURRENCY) {
    const slice = batch.slice(at, at + CONCURRENCY);
    const settled = await Promise.all(slice.map((item) => verifyOne(item.entry, item.identifier, search)));
    results.push(...settled);
  }
  return { results, total: verifiable.length };
}

async function verifyOne(
  entry: CiteEntry,
  identifier: CiteVerifyIdentifier,
  search: (query: string) => Promise<CiteSearchOutcome>,
): Promise<CiteVerification> {
  const outcome = await search(identifier.value);
  if (!outcome.ok) {
    // `not-found` 是「接口说没有这条记录」，不是网络错误——它照样是「未核验」
    return {
      key: entry.key,
      status: outcome.reason === "not-found" ? "not-found" : "error",
      identifier,
      found: null,
      reason: outcome.reason,
    };
  }
  if (outcome.results.length === 0) {
    return { key: entry.key, status: "not-found", identifier, found: null, reason: null };
  }
  const match = outcome.results.find((candidate) => titlesAgree(entry.title, candidate.title)) ?? null;
  if (match !== null) {
    return {
      key: entry.key,
      status: "verified",
      identifier,
      found: { title: match.title, year: match.year, doi: match.doi },
      reason: null,
    };
  }
  // 标题检索时「候选都不像」= 没找到；按 DOI / arXiv 号查到的却是另一篇 = 标识写错了
  if (identifier.kind === "title") {
    return { key: entry.key, status: "not-found", identifier, found: null, reason: null };
  }
  const first = outcome.results[0];
  return {
    key: entry.key,
    status: "mismatch",
    identifier,
    found: first === undefined ? null : { title: first.title, year: first.year, doi: first.doi },
    reason: null,
  };
}
