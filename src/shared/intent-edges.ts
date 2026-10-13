/**
 * intent-lab GET /edges 的契约（contract 7）—— 右栏「意图」图的数据面。
 *
 * 一问一图：`GET /edges?sessionId=S&turnId=T` 返回这一问召回的全部 (QA, 岗) 边
 * （入选 + 拿不准两档；低于 pass 的不会到 Orbita，图上不画）、分档阈值与 QA 之间
 * 的历史理由边（links）。进行中的召回先用 review 事件画，done 后以 /edges 为准。
 *
 * 解析是严格收窄（`parseIntentEdges`）：畸形 = 不可用（返回 null，调用方按
 * 「这一问没有图」处理）——半张图比没有图更误导。纯模块，不 import electron。
 */

/** 六个岗位（slot 1–6）：同一件事、同一目的、同构机制、取舍标准、约束条件、时序与修订。 */
export const INTENT_SLOTS: readonly { id: number; name: string }[] = [
  { id: 1, name: "同一件事" },
  { id: 2, name: "同一目的" },
  { id: 3, name: "同构机制" },
  { id: 4, name: "取舍标准" },
  { id: 5, name: "约束条件" },
  { id: 6, name: "时序与修订" },
];

/** 一条 (QA, 岗) 边：一份历史 QA 在一个岗位上的相关度判定。 */
export interface IntentEdge {
  qaId: string;
  /** 岗位 1–6 */
  slot: number;
  /** 相关度 0–1 */
  score: number;
  /** high = 入选（进上下文）；mid = 拿不准（守门员从中挑 ≤5 条问用户） */
  band: "high" | "mid";
  /** 第二步写的四段理由 */
  connection: string;
  prediction: string;
  evidence: string;
  assistant: string;
  /** 去重合并的份数，≥ 1 */
  dupCount: number;
  /** 这一条被守门员问过用户（拿不准档才有意义） */
  asked: boolean;
  /** 问用户时的陈述句；没问过为 null */
  statement: string | null;
  /** 用户表态：对 / 不对 / 不表态；没问过或未答为 null */
  verdict: "yes" | "no" | "skip" | null;
  /** 用户改过的说法；没改为 null */
  edited: string | null;
  /** 用户说「对」（或改字）后提升为入选 */
  promoted: boolean;
  /** 该 QA 的出处与原文 */
  qa: { ts: number; sessionId: string; title: string; source: string; q: string; a: string };
}

/**
 * QA 与 QA 之间的历史理由边：两个入选（或拿不准）QA 在**过去某问**里被连过、
 * 写过一句 connection。两端都在本次 edges 里；turnId / ts 是**当时那一问**的。
 * 图上画成与同岗时间链、同会话虚线不同的一种连线。
 */
export interface IntentLink {
  fromQaId: string;
  toQaId: string;
  slot: number;
  connection: string;
  /** 用户当时改过的说法（悬停优先显示）；没改为 null */
  edited: string | null;
  /** 当时用户的表态；未表态为 null */
  verdict: "yes" | "skip" | null;
  /** 历史联系发生的那一问（当时的 turnId） */
  turnId: string;
  /** 历史联系发生的时刻 */
  ts: number;
}

export interface IntentEdges {
  sessionId: string;
  turnId: string;
  /** 这一问的召回 run；没跑过召回为 null（edges 为空表） */
  runId: string | null;
  /** 分档阈值（按岗 1–6；服务端给什么画什么，图上不做从 0 起的滑杆） */
  thresholds: { pass: number[]; high: number[] };
  edges: IntentEdge[];
  links: IntentLink[];
}

/* ---------------------------------------------------------------- 严格解析 */

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function parseEdge(raw: unknown): IntentEdge | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const qaId = str(v["qaId"]);
  const slot = num(v["slot"]);
  const score = num(v["score"]);
  const band = v["band"];
  const dupCount = num(v["dupCount"]);
  const qaRaw = v["qa"];
  if (qaId === null || slot === null || slot < 1 || slot > 6 || score === null || dupCount === null) return null;
  if (band !== "high" && band !== "mid") return null;
  const connection = str(v["connection"]);
  const prediction = str(v["prediction"]);
  const evidence = str(v["evidence"]);
  const assistantText = str(v["assistant"]);
  if (connection === null || prediction === null || evidence === null || assistantText === null) return null;
  if (typeof qaRaw !== "object" || qaRaw === null) return null;
  const q = qaRaw as Record<string, unknown>;
  const ts = num(q["ts"]);
  const sessionId = str(q["sessionId"]);
  const title = str(q["title"]);
  const source = str(q["source"]);
  const questionText = str(q["q"]);
  const answerText = str(q["a"]);
  if (ts === null || sessionId === null || title === null || source === null || questionText === null || answerText === null) {
    return null;
  }
  const asked = v["asked"] === true;
  const statement = str(v["statement"]);
  const verdictRaw = v["verdict"];
  const verdict = verdictRaw === "yes" || verdictRaw === "no" || verdictRaw === "skip" ? verdictRaw : null;
  const edited = str(v["edited"]);
  return {
    qaId,
    slot,
    score,
    band,
    connection,
    prediction,
    evidence,
    assistant: assistantText,
    dupCount,
    asked,
    statement,
    verdict,
    edited,
    promoted: v["promoted"] === true,
    qa: { ts, sessionId, title, source, q: questionText, a: answerText },
  };
}

function parseLink(raw: unknown): IntentLink | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const fromQaId = str(v["fromQaId"]);
  const toQaId = str(v["toQaId"]);
  const slot = num(v["slot"]);
  const connection = str(v["connection"]);
  const turnId = str(v["turnId"]);
  const ts = num(v["ts"]);
  if (fromQaId === null || toQaId === null || slot === null || slot < 1 || slot > 6) return null;
  if (connection === null || turnId === null || ts === null) return null;
  const edited = str(v["edited"]);
  const verdictRaw = v["verdict"];
  const verdict = verdictRaw === "yes" || verdictRaw === "skip" ? verdictRaw : null;
  return { fromQaId, toQaId, slot, connection, edited, verdict, turnId, ts };
}

function parseNumberArray(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const item of raw) {
    const value = num(item);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/**
 * /edges 响应 → IntentEdges。**逐字段严格校验，任何一处畸形整个返回 null**
 * （探活 / 拉图语义下畸形等于不可用，不画半张图）。edges / links 里单条畸形
 * 也整个拒收——数不对的图会让人对着错的关系做判断。
 */
export function parseIntentEdges(raw: unknown): IntentEdges | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v["ok"] !== true) return null;
  const sessionId = str(v["sessionId"]);
  const turnId = str(v["turnId"]);
  if (sessionId === null || turnId === null) return null;
  const runId = str(v["runId"]);
  const thresholdsRaw = v["thresholds"];
  if (typeof thresholdsRaw !== "object" || thresholdsRaw === null) return null;
  const t = thresholdsRaw as Record<string, unknown>;
  const pass = parseNumberArray(t["pass"]);
  const high = parseNumberArray(t["high"]);
  if (pass === null || high === null) return null;
  if (!Array.isArray(v["edges"]) || !Array.isArray(v["links"])) return null;
  const edges: IntentEdge[] = [];
  for (const item of v["edges"]) {
    const edge = parseEdge(item);
    if (edge === null) return null;
    edges.push(edge);
  }
  const links: IntentLink[] = [];
  for (const item of v["links"]) {
    const link = parseLink(item);
    if (link === null) return null;
    links.push(link);
  }
  return { sessionId, turnId, runId, thresholds: { pass, high }, edges, links };
}
