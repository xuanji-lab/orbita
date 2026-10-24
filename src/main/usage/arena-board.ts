/**
 * Arena 榜单名 → Orbita 型号 id × 思考档。**纯模块**：不 import electron，可被 `node --test` 直接测。
 *
 * 榜单把每个思考档当成单独一行，档写在名字末尾的括号里：`Claude Opus 5.5 (Max)`。括号里还可能是：
 * - harness：`GPT-5.6 Sol (xHigh, Codex Harness)`——分数是在别家外壳里跑的，照收、悬停写明；
 * - 日期版本：`DeepSeek-V4-Pro (High, 20260813)`、`Qwen3.8-Max (0902)`，或者日期直接写在名字里
 *   `DeepSeek-V4.1-Flash-20261017 (Max)`；
 * - 别的限定词（`Kimi K2.5 (Thinking)`、`MiMo-V2-Flash (Non-Thinking)`）：不认识的一律**不映射**。
 * 没有括号（`GLM-5.3-Flash`、`MiniMax-M3`）= 榜单没标档：思考档记 null，**不猜档**。
 *
 * 映射用精确的榜单基名（去掉括号与名字里的日期之后），不用宽松正则——`Kimi K2.7 Code` 不是
 * kimi-for-coding（那是 K2.8 Preview，白名单的显示名），宽松匹配会把它顶替上去。
 */
import type { ThinkingLevel } from "../../shared/thinking.ts";

/** 快照里的一行：[榜单名, 分数, 置信下界, 置信上界, 样本量, 名次]（scripts/build-arena-snapshot.py） */
export type BoardRow = [name: string, score: number, lower: number, upper: number, samples: number, rank: number];

/** 榜单基名 → 同一个型号在各家服务商上的 Orbita id（别名共用一份分数） */
const BOARD_MODEL_IDS: Readonly<Record<string, readonly string[]>> = {
  "Kimi K3.1 Pro": ["kimi-k3.1-pro", "k3.1-pro", "kimi-k3.1-pro-highspeed", "k3.1-pro-highspeed"],
  "Kimi K3": ["kimi-k3", "k3", "k3-256k"],
  "Kimi K2.7 Code": ["kimi-k2.7-code"],
  "Kimi K2.6": ["kimi-k2.6"],
  "Claude Opus 5.5": ["claude-opus-5-5"],
  "Claude Sonnet 5.5": ["claude-sonnet-5-5"],
  "Claude Haiku 5.5": ["claude-haiku-5-5"],
  "Claude Fable 5.1": ["claude-fable-5-1"],
  "Claude Opus 5": ["claude-opus-5"],
  "Claude Sonnet 5": ["claude-sonnet-5"],
  "Claude Fable 5": ["claude-fable-5"],
  "GPT-6 Astra": ["gpt-6-astra"],
  "GPT-6 Luna": ["gpt-6-luna"],
  "GPT-6 Sol": ["gpt-6-sol"],
  "GPT-6.1 Sol": ["gpt-6.1-sol"],
  "GPT-5.6 Sol": ["gpt-5.6-sol"],
  "GPT-5.6 Terra": ["gpt-5.6-terra"],
  "GPT-5.6 Luna": ["gpt-5.6-luna"],
  "GLM-5.3": ["glm-5.3"],
  "GLM-5.3-Flash": ["glm-5.3-flash"],
  "DeepSeek-V4-Pro": ["deepseek-v4-pro"],
  "DeepSeek-V4.1-Flash": ["deepseek-v4.1-flash", "deepseek-flash"],
  "DeepSeek-V4-Flash": ["deepseek-v4-flash"],
  "Qwen3.8-Max": ["qwen3.8-max"],
  "MiniMax-M3": ["minimax-m3"],
  "Step 5 Preview": ["step-5-preview", "step-5-preview-free"],
  "MiMo-V2.6-Pro": ["mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"],
  "MiMo-V2.6-Flash": ["mimo-v2.6-flash"],
};

const BOARD_LEVELS: Readonly<Record<string, ThinkingLevel>> = {
  Low: "low",
  Medium: "medium",
  High: "high",
  xHigh: "xhigh",
  Max: "max",
};

interface ParsedBoardName {
  /** 去掉括号与名字里日期之后的基名 */
  base: string;
  thinking: ThinkingLevel | null;
  harness?: string;
  /** 日期版本原文（`20260813` / `0902`），没有就缺席 */
  version?: string;
  /** 括号里有认不得的限定词：这一行不映射 */
  unknownQualifier: boolean;
}

function parseBoardName(name: string): ParsedBoardName {
  let base = name.trim();
  let thinking: ThinkingLevel | null = null;
  let harness: string | undefined;
  let version: string | undefined;
  let unknownQualifier = false;
  const paren = /\s*\(([^()]*)\)\s*$/.exec(base);
  if (paren !== null) {
    base = base.slice(0, paren.index);
    for (const part of (paren[1] ?? "").split(",").map((p) => p.trim())) {
      if (part === "") continue;
      const level = Object.hasOwn(BOARD_LEVELS, part) ? BOARD_LEVELS[part] : undefined;
      if (level !== undefined) thinking = level;
      else if (/Harness$/.test(part)) harness = part;
      else if (/^\d{4}(\d{4})?$/.test(part)) version = part;
      else unknownQualifier = true;
    }
  }
  // 日期写在名字里：DeepSeek-V4.1-Flash-20261017
  const dated = /-(\d{8})$/.exec(base);
  if (dated !== null) {
    base = base.slice(0, dated.index);
    version ??= dated[1];
  }
  return {
    base,
    thinking,
    ...(harness === undefined ? {} : { harness }),
    ...(version === undefined ? {} : { version }),
    unknownQualifier,
  };
}

/** 榜单基名的规范写法：转小写、空白换连字符（`Grok 4.7` → `grok-4.7`）。只用来和 id 比相等 */
function normalizeBase(base: string): string {
  return base.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * 兜底查找表：快照里出现过的全部榜单基名，按规范写法索引。由调用方从快照建一次
 * （boardIndexOf），boardBaseOf / boardEntriesFor 在手写表查不到时用它。
 */
export type BoardIndex = ReadonlyMap<string, string>;

export function boardIndexOf(rowLists: readonly (readonly BoardRow[])[]): BoardIndex {
  const index = new Map<string, string>();
  for (const rows of rowLists) {
    for (const [name] of rows) {
      const parsed = parseBoardName(name);
      if (parsed.unknownQualifier) continue;
      index.set(normalizeBase(parsed.base), parsed.base);
    }
  }
  return index;
}

/**
 * Orbita 型号 id 对应的榜单基名。查不到 = 这个型号不在任何榜上。两层：
 *
 * 1. **手写表**（BOARD_MODEL_IDS）：先精确匹配，再取路径最后一段的小写（聚合网关写成
 *    `z-ai/glm-5.3`、`openai/gpt-5.6-sol`）。别名（k3 = kimi-k3）只能靠它。
 * 2. **规范化后精确相等**的兜底（给了 index 才查）：手写表只覆盖我们跟踪的那批型号，新服务商
 *    （xAI / Codex / Copilot）带进来的 id 一个都配不上——2026-10-24 用户加了 xAI 的 grok-4.7，
 *    Agent 榜上明明有 `Grok 4.7 (xHigh)`，却进了「未上榜」。榜单基名转小写、空白换连字符之后与
 *    id 最后一段**整串相等**才算：`Claude Opus 5` 不会配给 claude-opus-5-5、`GPT-6.1 Sol` 不会
 *    配给 gpt-6-luna。不做前缀、包含或编辑距离——宁可漏配进「未上榜」，不错配成别的型号的分。
 */
export function boardBaseOf(modelId: string, index?: BoardIndex): string | undefined {
  const tail = (modelId.split("/").pop() ?? modelId).toLowerCase();
  for (const candidate of [modelId, tail]) {
    for (const [base, ids] of Object.entries(BOARD_MODEL_IDS)) {
      if (ids.includes(candidate)) return base;
    }
  }
  return index?.get(tail);
}

export interface BoardEntry {
  name: string;
  thinking: ThinkingLevel | null;
  harness?: string;
  score: number;
  lower: number;
  upper: number;
  samples: number;
  rank: number;
}

/**
 * 日期版本的可比键（8 位 YYYYMMDD）。`0902` 这种只有月日的，按榜单发布年补年份；补出来
 * 晚于发布日就退一年（发布于 2026-01 的榜上写 1215，是 2025-12-15）。没有日期返回 null。
 */
function versionKey(version: string | undefined, publishDate: string): string | null {
  if (version === undefined) return null;
  if (version.length === 8) return version;
  const published = publishDate.replaceAll("-", "");
  const year = Number(published.slice(0, 4));
  const guess = `${year}${version}`;
  return guess > published ? `${year - 1}${version}` : guess;
}

/**
 * 这个型号在一个分类里的榜单条目，**同一个 id × 同一档只留一条**：
 *
 * 1. **同一个 id 对应多个日期版本时取最新的那个，其余丢掉**（用户 2026-10-24 拍板）。榜单无法
 *    告诉我们用户的 API 实际打到哪一版，型号 id 一般指向厂商的当前版本，所以取最新。
 *    「最新」的判定：都带日期时取日期最晚的（`-20261017` 胜 `-20260910`）；**不带日期的条目当作
 *    当前别名，算最新**（`Qwen3.8-Max` 胜 `Qwen3.8-Max (0902)`）——这一条是**推断，不是榜单说明
 *    写的**：数据集卡没解释命名，full split 的历史也只从 2026-10 起，分不出先后。
 * 2. 同一档里一条带 harness、一条不带：取不带的（分数出自 Arena 自己的外壳，口径一致）。
 * 3. 仍然并列（不应发生）取名次靠前的。
 *
 * 4. **同一个 id 在同一个分类里只要有标了档的条目，就丢掉没标档的那条**（用户 2026-10-24
 *    拍板）：deepseek-v4-pro 在榜上既有 `DeepSeek-V4-Pro (High, 20260813)` 又有不带括号的
 *    `DeepSeek-V4-Pro`，只留 High——没标档的那条多半是旧版本，画成第二个点只会让人以为同一个
 *    型号有两种表现。都没标档才保留未标档的那条（GLM-5.3-Flash、MiniMax-M3）。
 *    丢的是整条，不是把它的分数挪给某个档：那就成了猜档。
 *
 * 不同档各留一条：GPT-6 Luna 的 Low / Medium / Max 是三个点。
 */
export function boardEntriesFor(
  rows: readonly BoardRow[],
  modelId: string,
  publishDate: string,
  index?: BoardIndex,
): BoardEntry[] {
  const base = boardBaseOf(modelId, index);
  if (base === undefined) return [];
  const groups = new Map<string, { entry: BoardEntry; version: string | null; undated: boolean }[]>();
  for (const [name, score, lower, upper, samples, rank] of rows) {
    const parsed = parseBoardName(name);
    if (parsed.base !== base || parsed.unknownQualifier) continue;
    const entry: BoardEntry = {
      name,
      thinking: parsed.thinking,
      ...(parsed.harness === undefined ? {} : { harness: parsed.harness }),
      score,
      lower,
      upper,
      samples,
      rank,
    };
    const key = parsed.thinking ?? "none";
    const list = groups.get(key) ?? [];
    list.push({ entry, version: versionKey(parsed.version, publishDate), undated: parsed.version === undefined });
    groups.set(key, list);
  }
  // 规则 4：有标了档的组，就不要没标档的那组
  if (groups.size > 1) groups.delete("none");
  const picked: BoardEntry[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => {
      if (a.undated !== b.undated) return a.undated ? -1 : 1;
      if (a.version !== b.version) return (b.version ?? "").localeCompare(a.version ?? "");
      const harnessA = a.entry.harness === undefined ? 0 : 1;
      const harnessB = b.entry.harness === undefined ? 0 : 1;
      if (harnessA !== harnessB) return harnessA - harnessB;
      return a.entry.rank - b.entry.rank;
    });
    const first = sorted[0];
    if (first !== undefined) picked.push(first.entry);
  }
  return picked.sort((a, b) => a.rank - b.rank);
}
