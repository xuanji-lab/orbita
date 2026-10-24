/**
 * 收尾扫描 v2 的纯逻辑：轮次切分、扫描 / 改写的 prompt、严格解析、按轮汇总用量。
 * **纯模块**（只做 type import 之外的相对 import），renderer、主进程与 node --test 共用。
 *
 * 措辞就是契约：prompt 里约定的输出形状与本文件的解析器一一对应，改一处必须两处一起改。
 * intent-lab 仓库（src/server-contract.ts）有一份「认机器提问」的副本——v2 的 prompt 不再是
 * 固定全文，认法改成看首行标记 CLOSING_SCAN_HEAD，intent-lab 侧要同步（见 PR 描述）。
 */
import type { SessionRecord } from "./session.ts";
import { deriveSessionTitle } from "./session.ts";
import {
  WRAPUP_CHANGES,
  type WrapupChange,
  type WrapupCompaction,
  type WrapupDraft,
  type WrapupEntry,
  type WrapupPlan,
  type WrapupTokens,
  type WrapupTurn,
  type WrapupTurnUsage,
} from "./wrapup.ts";
import type { ThinkingLevel } from "./thinking.ts";

/**
 * v1 的扫描 prompt 全文（2026-10 之前的会话里存着它）。只用来**认**历史里的机器提问——
 * 它不是一轮、不进意图系统；不再发出。
 */
export const LEGACY_CLOSING_SCAN_PROMPT = `这个会话已经完成了。回看整段对话，把还没做完的事（答应要做的、被岔开的、明确延后的）扫描出来。
只输出一个 fenced json 代码块，不要输出任何其他内容：
{"carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
没有就输出 {"carryovers": []}。
输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON（字符串里的双引号与换行已转义，没有尾逗号、没有注释）；
- 每一项恰好有 title 和 detail 两个键，不重复、不缺、不多；
- title 是非空字符串，detail 是字符串，都不能是 null。
发现问题就整块重新生成，只交出通过自检的那一版。`;

/** v2 扫描 prompt 的首行：认机器提问就认它（prompt 其余部分随轮次表变化） */
export const CLOSING_SCAN_HEAD = "【Orbita 收尾扫描】";

/** 这一轮文本是不是收尾扫描的机器提问（v2 看首行标记；v1 认全文） */
export function isClosingScanText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(CLOSING_SCAN_HEAD) || trimmed === LEGACY_CLOSING_SCAN_PROMPT.trim();
}

/** 用户消息的纯文字（全部 text 块拼接） */
function userText(record: SessionRecord): string | null {
  if (record.role !== "user") return null;
  return record.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 切出来的一轮：在记录数组里的下标区间 [start, end) */
export interface TurnSpan {
  n: number;
  userId: string;
  preview: string;
  start: number;
  end: number;
}

/**
 * 按「第 n 轮」的定义（shared/wrapup.ts 文件头）切轮：第 n 条真人用户消息起，到下一条用户消息
 * （含机器提问）之前。机器提问与它后面的回答不属于任何一轮。通道标记不切轮。
 */
export function splitTurns(records: readonly SessionRecord[]): TurnSpan[] {
  const turns: TurnSpan[] = [];
  let open: TurnSpan | null = null;
  records.forEach((record, index) => {
    const text = userText(record);
    if (text === null) return;
    if (open !== null) {
      open.end = index;
      turns.push(open);
      open = null;
    }
    if (isClosingScanText(text)) return;
    open = { n: turns.length + 1, userId: record.id, preview: deriveSessionTitle(text), start: index, end: records.length };
  });
  if (open !== null) turns.push(open);
  return turns;
}

/**
 * 会话里的压缩点：每条 compacted 记录发生时已经开始了几轮（真人用户消息数）+ 它的摘要。
 * 预检压缩的界碑落在刚发的那句之前，afterTurn 因此不含那一轮——那一轮的原文在压缩之后，模型看得到。
 */
export function compactionPoints(records: readonly SessionRecord[]): WrapupCompaction[] {
  const points: WrapupCompaction[] = [];
  let turns = 0;
  for (const record of records) {
    if (record.role === "compacted") {
      points.push({ afterTurn: turns, summary: record.summary });
      continue;
    }
    const text = userText(record);
    if (text !== null && !isClosingScanText(text)) turns += 1;
  }
  return points;
}

/**
 * 本次范围里要靠摘要看的那几段：压缩点 afterTurn ≥ sinceTurn 的，每段覆盖「上一个压缩点之后
 * （至少 sinceTurn）到这个压缩点」的轮次。只有最后一次压缩之后的轮次模型看得到原文。
 */
export function compactedSegments(
  plan: Pick<WrapupPlan, "sinceTurn" | "compactions">,
): { from: number; to: number; summary: string }[] {
  const out: { from: number; to: number; summary: string }[] = [];
  let prev = plan.sinceTurn - 1;
  for (const point of plan.compactions) {
    if (point.afterTurn < plan.sinceTurn) continue;
    if (point.afterTurn > prev) out.push({ from: prev + 1, to: point.afterTurn, summary: point.summary });
    prev = Math.max(prev, point.afterTurn);
  }
  return out;
}

// —— 扫描 prompt ——

/** 轮次表的一行：首行截断（「（只有附件）」兜底，免得模型看到一行空白） */
function turnLine(turn: Pick<WrapupTurn, "n" | "preview">): string {
  return `第 ${turn.n} 轮：${turn.preview === "" ? "（没有文字，只有附件）" : turn.preview}`;
}

/** 收尾扫描的机器提问全文（作为一条普通用户消息发进同一个会话，复用对话缓存） */
export function buildClosingScanPrompt(
  plan: Pick<WrapupPlan, "sinceTurn" | "lastTurn" | "turns"> & Partial<Pick<WrapupPlan, "compactions">>,
): string {
  const range = `${plan.sinceTurn}–${plan.lastTurn}`;
  const segments = compactedSegments({ sinceTurn: plan.sinceTurn, compactions: plan.compactions ?? [] });
  const compacted =
    segments.length === 0
      ? ""
      : `
这个会话中途压缩过 ${segments.length} 次：压缩点之前的轮次原文已经不在你的上下文里，只剩当时的摘要。
下面按段给出每次压缩的摘要（摘要可能连带复述更早的内容，只归纳该段轮次范围里的事）。先逐段归纳每段做完了什么、留下了什么，再和最后一次压缩之后的轮次（原文你看得到）整合成一份清单；一件事跨了几段就合成一项，轮次写跨的全程。
${segments.map((segment) => `\n【${segment.from === segment.to ? `第 ${segment.from} 轮` : `第 ${segment.from}–${segment.to} 轮`} · 压缩摘要】\n${segment.summary.trim()}`).join("\n")}
`;
  return `${CLOSING_SCAN_HEAD}
这个任务要收尾了。回看第 ${range} 轮对话，列出两样东西：
1. 做完的事：用户要的、已经做成的每一件事，各占第几轮到第几轮；
2. 留下的事：还没做完的（答应要做的、被岔开的、明确延后的）。

「第 n 轮」= 第 n 条用户消息起、到下一条用户消息前。本次要看的轮次：
${plan.turns.map(turnLine).join("\n")}
${compacted}
只输出一个 fenced json 代码块，不要输出任何其他内容：
{"done": [{"title": "一句话说做成了什么", "turns": [起始轮, 结束轮]}], "carryovers": [{"title": "一句话事项", "detail": "上下文摘录"}]}
一件事跨了好几轮就合成一项；只是闲聊、没有要做成的事的轮次可以不列。两样都没有就输出 {"done": [], "carryovers": []}。
输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON（字符串里的双引号与换行已转义，没有尾逗号、没有注释）；
- done 的每一项恰好有 title 和 turns 两个键；turns 是两个整数 [起, 止]，起 ≤ 止，都在 ${range} 之间；各项的轮次互不重叠；
- carryovers 的每一项恰好有 title 和 detail 两个键；
- title 是非空字符串，detail 是字符串，都不能是 null。
发现问题就整块重新生成，只交出通过自检的那一版。`;
}

// —— fenced json 抽取 ——

const FENCE_RE = /^([ \t]*```)[ \t]*([A-Za-z0-9_-]*)[ \t]*$/;

/**
 * 一段 markdown 里全部完整的 json / 无标注围栏块（按出现顺序）。围栏是开 / 闭交替的：不在栏内才
 * 可能是开栏——不跟踪这个状态，一个 ```text 块的收栏会被当成无标注的新开栏。尾围栏缺失（流被截断）
 * 的半截丢弃。
 */
export function fencedJsonBlocks(markdown: string): string[] {
  let inFence = false;
  let buffer: string[] | null = null;
  const blocks: string[] = [];
  for (const line of markdown.split("\n")) {
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      if (inFence) {
        if (buffer !== null) blocks.push(buffer.join("\n"));
        buffer = null;
        inFence = false;
        continue;
      }
      const lang = fence[2] ?? "";
      inFence = true;
      if (lang === "" || lang.toLowerCase() === "json") buffer = [];
      continue;
    }
    if (buffer !== null) buffer.push(line);
  }
  return blocks;
}

/** 整条消息恰好是一个 json 围栏块时返回块内容，否则 null（卡片化渲染用：多吞一个字都是丢内容） */
export function soleFencedJson(text: string): string | null {
  const lines = text.trim().split("\n");
  if (lines.length < 3) return null;
  const open = FENCE_RE.exec(lines[0] ?? "");
  if (open === null) return null;
  const lang = open[2] ?? "";
  if (!(lang === "" || lang.toLowerCase() === "json")) return null;
  for (let i = 1; i < lines.length - 1; i += 1) {
    if (FENCE_RE.test(lines[i] ?? "")) return null;
  }
  if (FENCE_RE.exec(lines[lines.length - 1] ?? "") === null) return null;
  return lines.slice(1, -1).join("\n");
}

// —— 严格解析 ——

/** 轮号的合法范围（含两端） */
export interface TurnRange {
  sinceTurn: number;
  lastTurn: number;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(record);
  return required.every((key) => key in record) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function parseTurns(raw: unknown, range: TurnRange): [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [from, to] = raw as unknown[];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  const a = from as number;
  const b = to as number;
  if (a > b || a < range.sinceTurn || b > range.lastTurn) return null;
  return [a, b];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 各项的轮次互不重叠（重叠的话同一轮的花费会算进两件事） */
function disjoint(entries: readonly WrapupEntry[]): boolean {
  const ranges = entries.flatMap((entry) => (entry.turns === null ? [] : [entry.turns])).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1];
    const cur = ranges[i];
    if (prev !== undefined && cur !== undefined && cur[0] <= prev[1]) return false;
  }
  return true;
}

/**
 * 扫描回答 → 清单。**半残不进 UI**：坏 JSON、缺键多键、类型错、轮号越界或重叠，一律 null，由调用方
 * 降级（会话照标完成、提示可以重试）——一张半残清单比降级更糟。
 */
export function parseWrapupBlock(text: string, range: TurnRange): WrapupDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root["done"]) || !Array.isArray(root["carryovers"])) return null;
  const done: WrapupEntry[] = [];
  for (const entry of root["done"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (!exactKeys(record, ["title", "turns"]) || !nonEmpty(record["title"])) return null;
    const turns = parseTurns(record["turns"], range);
    if (turns === null) return null;
    done.push({ title: record["title"].trim(), detail: "", turns });
  }
  if (!disjoint(done)) return null;
  const left: WrapupEntry[] = [];
  for (const entry of root["carryovers"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (!exactKeys(record, ["title", "detail"]) || !nonEmpty(record["title"]) || typeof record["detail"] !== "string") {
      return null;
    }
    left.push({ title: record["title"].trim(), detail: record["detail"], turns: null });
  }
  return { done, left };
}

/** 从一段 markdown 里取第一个能严格解析的块（模型复读两遍时第一遍是它的答案） */
export function parseWrapupScan(markdown: string, range: TurnRange): WrapupDraft | null {
  for (const block of fencedJsonBlocks(markdown)) {
    const parsed = parseWrapupBlock(block, range);
    if (parsed !== null) return parsed;
  }
  return null;
}

// —— 按反馈改写 ——

export const WRAPUP_REVISE_SYSTEM = `你在帮用户改一份任务收尾清单。清单分两组：「做完的事」（每件写明占第几轮到第几轮）与「留下的事」（还没做完、要进遗留清单的）。
用户会用一句话说哪里不对（可能是口述转写，有错字）。按他说的改清单，其余保持原样，然后交出改好的整份清单。`;

function draftJson(draft: WrapupDraft): string {
  return JSON.stringify(
    {
      done: draft.done.map((entry) => ({ title: entry.title, turns: entry.turns })),
      carryovers: draft.left.map((entry) => ({ title: entry.title, detail: entry.detail, turns: entry.turns })),
    },
    null,
    1,
  );
}

/** 改写请求的 prompt：轮次表 + 当前清单 + 用户这句话 */
export function buildWrapupRevisePrompt(input: {
  turns: readonly Pick<WrapupTurn, "n" | "preview">[];
  sinceTurn: number;
  lastTurn: number;
  draft: WrapupDraft;
  feedback: string;
}): string {
  const range = `${input.sinceTurn}–${input.lastTurn}`;
  return `轮次表（「第 n 轮」= 第 n 条用户消息起、到下一条用户消息前）：
${input.turns.map(turnLine).join("\n")}

当前清单：
${draftJson(input.draft)}

用户说：${input.feedback.trim()}

只输出一个 fenced json 代码块，不要输出任何其他内容：
{"summary": "一句话说你改了什么", "done": [{"title": "…", "turns": [起, 止], "change": "…"}], "carryovers": [{"title": "…", "detail": "…", "turns": [起, 止] 或 null, "change": "…"}]}
change 只给改过的项，取值：merged（几件合成一件）、moved-to-left（从做完的事挪到留下的事）、moved-to-done（从留下的事挪到做完的事）、added（新加的）、edited（改了标题或内容）；没改的项不写 change。
输出前逐条自检，结果会被程序严格解析，任何一条不合格整份作废：
- 整块是合法 JSON；summary 是非空字符串；
- done 的每一项有 title、turns，可选 change；turns 是两个整数 [起, 止]，起 ≤ 止，都在 ${range} 之间；各项的轮次互不重叠；
- carryovers 的每一项有 title、detail、turns，可选 change；turns 是 [起, 止] 或 null；
- title 是非空字符串，detail 是字符串；change 只能是上面五个值之一。
发现问题就整块重新生成，只交出通过自检的那一版。`;
}

function parseChange(raw: unknown): WrapupChange | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "string" && (WRAPUP_CHANGES as readonly string[]).includes(raw) ? (raw as WrapupChange) : null;
}

/** 改写回答 → 新清单 + 一句说明。严格，同 parseWrapupBlock */
export function parseWrapupRevise(markdown: string, range: TurnRange): { draft: WrapupDraft; summary: string } | null {
  for (const block of fencedJsonBlocks(markdown)) {
    const parsed = parseReviseBlock(block, range);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseReviseBlock(text: string, range: TurnRange): { draft: WrapupDraft; summary: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["summary", "done", "carryovers"]) || !nonEmpty(root["summary"])) return null;
  if (!Array.isArray(root["done"]) || !Array.isArray(root["carryovers"])) return null;
  const done: WrapupEntry[] = [];
  for (const entry of root["done"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (!exactKeys(record, ["title", "turns"], ["change"]) || !nonEmpty(record["title"])) return null;
    const turns = parseTurns(record["turns"], range);
    const change = parseChange(record["change"]);
    if (turns === null || change === null) return null;
    done.push({ title: record["title"].trim(), detail: "", turns, ...(change === undefined ? {} : { change }) });
  }
  if (!disjoint(done)) return null;
  const left: WrapupEntry[] = [];
  for (const entry of root["carryovers"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (!exactKeys(record, ["title", "detail", "turns"], ["change"]) || !nonEmpty(record["title"])) return null;
    if (typeof record["detail"] !== "string") return null;
    const turns = record["turns"] === null ? null : parseTurns(record["turns"], range);
    if (record["turns"] !== null && turns === null) return null;
    const change = parseChange(record["change"]);
    if (change === null) return null;
    left.push({ title: record["title"].trim(), detail: record["detail"], turns, ...(change === undefined ? {} : { change }) });
  }
  return { draft: { done, left }, summary: root["summary"].trim() };
}

// —— 按轮汇总用量 ——

const ZERO: WrapupTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addWrapupTokens(a: WrapupTokens, b: WrapupTokens): WrapupTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function wrapupTokenTotal(t: WrapupTokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** 一件做完的事的账：那几轮合计，算给 token 最多的「服务商 × 型号 × 档」 */
export interface WrapupItemTotals {
  providerId: string | null;
  modelId: string | null;
  level: ThinkingLevel | null;
  tokens: WrapupTokens;
  recordedCost: number;
  unpricedTokens: WrapupTokens;
  /** 折算官方价合计；任何一段折不出就 null */
  officialCost: number | null;
}

/**
 * 第 from–to 轮的合计（turns 只给计划里的那些轮，不在里面的轮号贡献 0）。归属：按「服务商 × 型号 × 档」
 * 合计 token，取最多的那一组（用户 2026-10-24：「算给这几轮里 token 最多的型号 × 档」）；并列取先出现的。
 */
export function wrapupItemTotals(turns: readonly WrapupTurn[], range: [number, number] | null): WrapupItemTotals {
  const groups = new Map<string, { usage: WrapupTurnUsage; tokens: number }>();
  let tokens = ZERO;
  let unpriced = ZERO;
  let recordedCost = 0;
  let officialCost: number | null = 0;
  if (range !== null) {
    for (const turn of turns) {
      if (turn.n < range[0] || turn.n > range[1]) continue;
      for (const usage of turn.usage) {
        tokens = addWrapupTokens(tokens, usage.tokens);
        unpriced = addWrapupTokens(unpriced, usage.unpricedTokens);
        recordedCost += usage.recordedCost;
        officialCost = officialCost === null || usage.officialCost === null ? null : officialCost + usage.officialCost;
        const key = `${usage.providerId}\u0000${usage.modelId}\u0000${usage.level ?? ""}`;
        const prev = groups.get(key);
        groups.set(key, { usage, tokens: (prev?.tokens ?? 0) + wrapupTokenTotal(usage.tokens) });
      }
    }
  }
  let top: { usage: WrapupTurnUsage; tokens: number } | null = null;
  for (const group of groups.values()) {
    if (top === null || group.tokens > top.tokens) top = group;
  }
  return {
    providerId: top?.usage.providerId ?? null,
    modelId: top?.usage.modelId ?? null,
    level: top?.usage.level ?? null,
    tokens,
    recordedCost,
    unpricedTokens: unpriced,
    officialCost: top === null ? null : officialCost,
  };
}
