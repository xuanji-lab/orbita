/**
 * 上下文面板的数据推导 —— 从转录纯推导「agent 这一刻脑子里装了什么」。
 *
 * 右栏「上下文」面板按来源分组展示进入模型上下文的东西，回答的是 Kimi 右侧
 * 「上下文」卡那一类问题：agent 读了哪些文件、翻了哪些网页、看了哪些别的会话。
 * 除「规则与说明」组（系统提示注入，走 `ContextRulesInventory` 事件，见
 * agent-ipc.ts）外，全部来源都能从转录记录本身识别——本模块不碰 IPC、不碰 DOM，
 * renderer 拿 `mergeSideRecords` 合出来的生效视图直接喂进来。
 *
 * **口径与已知近似**（面板是「让用户大致知道装了什么」的展示，不是精确账本）：
 * - token 一律估算（estimateContextTokens），误差约 ±30%，绝不用于计费或压缩判定；
 * - 「已压缩出上下文」（gone）：最后一条压缩界碑**之前**的记录视为已出上下文。
 *   pi 的真实切点是 firstKeptEntryId——界碑前还有一段 keep-recent 窗口
 *   （≤ min(20000, 窗口 25%) 估算 token，pi compaction.ts 的 findCutPoint）原样
 *   保留，但那个 id 不落在我们的转录里，无从对准。灰显是「已折叠进摘要」的近似；
 * - 通道投递（channel-mark）顶替了一条 user 消息进 pi 本子，正文在通道账本里、
 *   这里没有——它计入轮号但不产条目，token 归不入任何组（已知漏计）；
 * - 意图召回的注入块只活在 pi 本子（intent-recall 记录不含正文），同样归不入组；
 * - 压缩摘要本身在上下文里（它替换了更早的历史），暂不单列。
 *
 * 纯模块：不 import electron、不 import 进程相关的东西，可被 `node --test` 直接加载。
 */
import type { ContextRulesInventory } from "./agent-ipc.ts";
import { findInvocationTokens } from "./invocation.ts";
import { parseQualifiedToolName } from "./mcp.ts";
import { pathTail, pathWithin } from "./path.ts";
import { splitUserTextBlocks } from "./prompt-attachments.ts";
import type { TranscriptRecord } from "./session.ts";
import { parseQuotedMessage } from "./quote.ts";
import { parseSkillSegments } from "./skill.ts";

/** 面板的两档视野：turn = 本轮新增了什么；task = 整个任务累积了什么（含已压缩灰显）。 */
export type ContextScope = "turn" | "task";

/**
 * token 估算：中日韩字符 × 0.7 + 其余 × 4 字符/token。
 *
 * 现代编码器对中文常见文本约 1.4–1.7 字符/token（≈0.6–0.7 token/字），对英文约
 * 3–4 字符/token，取 0.7 与 1/4 居中偏保守。pi 内核自己的 estimateTokens 是
 * 无差别 chars/4——对中文高估 4 倍，不适合这个中英混排的面板。口径只服务展示，
 * 不与 pi 的压缩判定对账。
 */
export function estimateContextTokens(text: string): number {
  return estimateTokensFromCounts(countCharKinds(text));
}

/** 预计数版本（事件载荷等只有字符数时用）；cjk 不应超过 chars。 */
export function estimateTokensFromCounts(counts: { chars: number; cjk: number }): number {
  const other = Math.max(0, counts.chars - counts.cjk);
  return Math.ceil(counts.cjk * 0.7 + other / 4);
}

/** 码点计数：总字符数与其中 CJK 码点数（含汉字、假名、注音、全角形式与扩展区）。 */
export function countCharKinds(text: string): { chars: number; cjk: number } {
  let chars = 0;
  let cjk = 0;
  for (const ch of text) {
    chars += 1;
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首·假名·注音·汉字基本区
      (code >= 0xf900 && code <= 0xfaff) || // 汉字兼容区
      (code >= 0xff00 && code <= 0xffef) || // 全角形式
      (code >= 0x20000 && code <= 0x3ffff) // 汉字扩展区（平面 2/3）
    ) {
      cjk += 1;
    }
  }
  return { chars, cjk };
}

/**
 * 一张附图 / 截图占多少 token 的估算。取 pi 的口径（ESTIMATED_IMAGE_CHARS 4800 ÷ 4，
 * compaction.ts）——图片在上下文里按图算，与文本估算无关。
 */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/** 附件引用行等给 UI 的截断长度（码点）。 */
const LABEL_MAX_CHARS = 40;

function clampLabel(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= LABEL_MAX_CHARS) return text;
  return `${chars.slice(0, LABEL_MAX_CHARS).join("")}…`;
}

/** 工具入参里取一个字符串字段（入参是模型的 JSON，逐字段验形状，不猜）。 */
function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberField(input: unknown, key: string): number | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 工具结果的估算 token：文本按估算器、图片按 IMAGE_TOKEN_ESTIMATE。 */
function toolContentTokens(content: readonly unknown[]): number {
  let tokens = 0;
  let text = "";
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") text += record["text"];
    else if (record["type"] === "image") tokens += IMAGE_TOKEN_ESTIMATE;
  }
  return tokens + estimateContextTokens(text);
}

/** 工具 item 的 details（只给 UI 的卡，不入模型上下文；这里只借它的 url / 标题）。 */
function detailsRecord(record: TranscriptRecord): Record<string, unknown> | null {
  if (typeof record !== "object" || record === null) return null;
  const details = (record as { details?: unknown }).details;
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : null;
}

function cardField(details: Record<string, unknown> | null, card: string, key: string): string | undefined {
  const inner = details?.[card];
  if (typeof inner !== "object" || inner === null) return undefined;
  return stringField(inner, key);
}

/* ---------------------------------------------------------------------------
 * 行类型：每组一行一个条目，跨轮合并（同一文件读两次 = 一行、两段范围）。
 * turn = 首次出现的轮号（按用户消息计，1 起；通道投递同 user 计）。
 * gone = 该条目全部出现都在最后一条压缩界碑之前（已折叠进摘要的近似）。
 * tokens = 估算，口径见 estimateContextTokens。
 * ------------------------------------------------------------------------- */

export interface ContextRowBase {
  turn: number;
  gone: boolean;
  tokens: number;
}

/** 「你附带的」：用户消息里随正文进入上下文的东西。 */
export interface ContextAttachRow extends ContextRowBase {
  kind: "quote" | "pasted" | "file-ref" | "image";
  /** 显示主标：引用摘句 / 路径 / 「粘贴块」/「图片」 */
  label: string;
  /** 副标（来源轮、字数、张数等；没有就是 null） */
  detail: string | null;
  /** 同条目合并的个数：图片 = 一轮几张，文件引用 = 引用几次，引用/粘贴恒 1 */
  count: number;
}

/** 「文件」组的一行：一个被读取工具碰过的文件。 */
export interface ContextFileRow extends ContextRowBase {
  /** 显示路径：cwd 内为相对路径，cwd 外为原路径（outside = true） */
  path: string;
  name: string;
  outside: boolean;
  /** 读取范围标签（"全文" / "L1–100" / "第 3–7 页"），多次读取去重后按首次顺序 */
  ranges: string[];
}

export interface ContextFileDir {
  /** 目录显示路径；cwd 根目录用 "."；cwd 外目录为绝对路径 */
  dir: string;
  outside: boolean;
  rows: ContextFileRow[];
  tokens: number;
}

/**
 * 搜索类工具（grep / find / ls）的小计：结果确实进上下文，但逐条列行会淹没
 * 真正的文件——按「工具 × 次数 + 估算 token」给文件组一行小计。
 */
export interface ContextSearchNote extends ContextRowBase {
  tool: string;
  count: number;
}

/** 「网页」组的一行：一次 browser_navigate 到达的页面。 */
export interface ContextWebRow extends ContextRowBase {
  url: string;
  title: string | null;
  domain: string | null;
}

/** 「其他会话」组的一行：一次（或几次）read_task。 */
export interface ContextTaskRow extends ContextRowBase {
  /** 模型给的 task 参数原样（id / 标题 / ext:…；目录模式为空串） */
  ref: string;
  /** 结果卡上的标题；目录模式 / 卡缺席为 null */
  title: string | null;
  external: boolean;
  /** 目录模式（不带 task 参数列出工作区兄弟会话） */
  catalog: boolean;
  /** 读过的轮号串（模型给的原文，如 "3", "2-5"），多次合并；没指定过 = null */
  rounds: string[] | null;
}

/** 「MCP 服务」组的一行：server › tool（或 /mcp: 点名，tool 为空串）。 */
export interface ContextMcpRow extends ContextRowBase {
  server: string;
  /** "" = /mcp: 点名注入的指令块，不是一次工具调用 */
  tool: string;
  /** 入参里的检索词（query / search_query / q / text 取第一个命中的字符串）；没有 null */
  query: string | null;
  calls: number;
}

/** 「技能」组的一行：/skill: 点名（指令块随消息进上下文）或 SKILL.md 被读入。 */
export interface ContextSkillRow extends ContextRowBase {
  name: string;
  how: "invoked" | "read";
}

/** 「规则与说明」组：来自 contextInventory 事件，恒为当前态（每轮重注入、不被压缩）。 */
export interface ContextRulesGroup {
  files: { path: string; name: string; scope: "global" | "project"; tokens: number }[];
  /** pi 基底（含 files 与 skillsIndex 的量），见 ContextRulesInventory.baseTokens */
  baseTokens: number;
  skillsIndex: { names: string[]; tokens: number };
  segments: { id: string; tokens: number }[];
  /** 组合计 = baseTokens + Σsegments */
  tokens: number;
}

export interface ContextInventory {
  scope: ContextScope;
  /** 当前轮号（最近一条 user / 通道投递的轮；还没说过话 = 0） */
  currentTurn: number;
  /** 生效视图里压缩过几次 */
  compactions: number;
  /** null = 这条会话没收到过注入清单（未开过轮），面板按「未知」显示 */
  rules: ContextRulesGroup | null;
  attach: { rows: ContextAttachRow[]; tokens: number };
  files: { dirs: ContextFileDir[]; searches: ContextSearchNote[]; tokens: number };
  web: { rows: ContextWebRow[]; tokens: number };
  tasks: { rows: ContextTaskRow[]; tokens: number };
  mcp: { rows: ContextMcpRow[]; tokens: number };
  skills: { rows: ContextSkillRow[]; tokens: number };
}

export interface ContextInventoryInput {
  /** 生效视图（renderer 的 mergeSideRecords 产物；主进程侧给 SessionRecord[] 也可） */
  records: readonly TranscriptRecord[];
  cwd: string;
  scope: ContextScope;
  /** contextInventory 事件推来的清单；不给 / null = 规则组未知 */
  rules?: ContextRulesInventory | null;
}

/** 一条出现记录：第几轮、是否已被压缩出去、这次占了多少估算 token。 */
interface Occurrence {
  turn: number;
  gone: boolean;
  tokens: number;
}

/** 累积器：一行 = 出现列表 + 显示字段（显示字段按规则随出现更新）。 */
interface Accum<T> {
  occurrences: Occurrence[];
  display: T;
}

/** read 工具的行范围标签（pi 的 read：offset 1 起行号，limit 行数）。 */
function readRangeLabel(input: unknown): string {
  const offset = numberField(input, "offset");
  const limit = numberField(input, "limit");
  if (offset === undefined && limit === undefined) return "全文";
  if (offset !== undefined && limit !== undefined) return `L${Math.floor(offset)}–${Math.floor(offset + limit - 1)}`;
  if (offset !== undefined) return `L${Math.floor(offset)}–…`;
  return `L1–${Math.floor(limit ?? 0)}`;
}

/** read_pdf 的页范围标签（offset 1 起页码，limit 页数；不给 = 默认 20 页窗口）。 */
function pdfRangeLabel(input: unknown): string {
  const offset = numberField(input, "offset");
  const limit = numberField(input, "limit");
  if (offset === undefined && limit === undefined) return "默认 20 页";
  if (offset !== undefined && limit !== undefined) return `第 ${Math.floor(offset)}–${Math.floor(offset + limit - 1)} 页`;
  if (offset !== undefined) return `第 ${Math.floor(offset)} 页起`;
  return `第 1–${Math.floor(limit ?? 0)} 页`;
}

/** 路径以 `<slug>/SKILL.md` 结尾 = 在读某个技能的正文（渐进披露的按需加载）。 */
const SKILL_MD_TAIL = /(^|\/)([^/]+)\/skill\.md$/i;

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/** cwd 相对化：cwd 内给相对显示路径，cwd 外原样并标 outside。 */
function displayPath(cwd: string, path: string): { display: string; outside: boolean } {
  const normalized = normalizeSeparators(path);
  const base = normalizeSeparators(cwd);
  if (base !== "" && pathWithin(base, normalized)) {
    const rel = normalized.slice(base.length).replace(/^\//, "");
    return { display: rel === "" ? "." : rel, outside: false };
  }
  return { display: normalized, outside: true };
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "." : path.slice(0, at);
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * 主推导：records → ContextInventory。
 *
 * 一遍扫描：先记轮号与压缩界碑，再按记录类型分流到六个组的累积器（Map 保首次
 * 出现顺序），最后按 scope 裁剪。识别只认工具名与转录里的块标签——它们是模型与
 * 转录的共同语言（quote 的先例），换内核时适配层保证这两样不变，这里就不用动。
 */
export function buildContextInventory(input: ContextInventoryInput): ContextInventory {
  const { records, cwd, scope } = input;

  // —— 第一遍：轮号 + 界碑位置（gone 只取决于记录在数组里的位置） ——
  let turn = 0;
  let compactions = 0;
  let lastBoundaryIndex = -1;
  const indexed: { record: TranscriptRecord; index: number; turn: number }[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    // 通道投递与 user 同级开轮（它顶替的就是 pi 本子里的一条 user 消息）
    if (record.role === "user" || record.role === "channel-mark") turn += 1;
    if (record.role === "compacted") {
      compactions += 1;
      lastBoundaryIndex = index;
    }
    indexed.push({ record, index, turn });
  }
  const currentTurn = turn;

  // —— 各组累积器 ——
  const attachRows = new Map<string, Accum<{ kind: ContextAttachRow["kind"]; label: string; detail: string | null; count: number }>>();
  const fileRows = new Map<string, Accum<{ path: string; name: string; outside: boolean; ranges: string[] }>>();
  const searchNotes = new Map<string, { occurrences: Occurrence[]; tool: string }>();
  const webRows = new Map<string, Accum<{ url: string; title: string | null; domain: string | null }>>();
  const taskRows = new Map<string, Accum<{ ref: string; title: string | null; external: boolean; catalog: boolean; rounds: string[] | null }>>();
  const mcpRows = new Map<string, Accum<{ server: string; tool: string; query: string | null }>>();
  const skillRows = new Map<string, Accum<{ name: string; how: "invoked" | "read" }>>();

  const pushOccurrence = <T>(map: Map<string, Accum<T>>, key: string, display: T, occurrence: Occurrence): void => {
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, { occurrences: [occurrence], display });
      return;
    }
    existing.occurrences.push(occurrence);
  };

  /** 浏览器工具的「当前页」：navigate 换页，其余工具的结果记到当前页那行上。 */
  let currentPageKey: string | null = null;

  for (const { record, index, turn: itemTurn } of indexed) {
    const gone = lastBoundaryIndex >= 0 && index < lastBoundaryIndex;

    if (record.role === "user") {
      const blocks = record.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text);
      const { body, pasted, files } = splitUserTextBlocks(blocks);

      for (const text of pasted) {
        const { chars } = countCharKinds(text);
        pushOccurrence(attachRows, `pasted:${itemTurn}:${chars}`, { kind: "pasted", label: "粘贴块", detail: `${chars} 字`, count: 1 }, { turn: itemTurn, gone, tokens: estimateContextTokens(text) });
      }
      for (const ref of files) {
        const key = `file-ref:${normalizeSeparators(ref.path)}`;
        const existing = attachRows.get(key);
        const occurrence: Occurrence = { turn: itemTurn, gone, tokens: estimateContextTokens(`- ${ref.path}`) };
        if (existing === undefined) {
          pushOccurrence(attachRows, key, { kind: "file-ref", label: ref.path, detail: ref.kind === "dir" ? "目录" : null, count: 1 }, occurrence);
        } else {
          existing.occurrences.push(occurrence);
        }
      }

      // 图片块：一轮多张合并一行
      const images = record.content.filter((block) => block.type === "image").length;
      if (images > 0) {
        pushOccurrence(attachRows, `image:${itemTurn}`, { kind: "image", label: "图片", detail: `${images} 张`, count: images }, { turn: itemTurn, gone, tokens: images * IMAGE_TOKEN_ESTIMATE });
      }

      // 引用块与点名指令都长在正文里
      const { quotes, text } = parseQuotedMessage(body);
      for (const quote of quotes) {
        const detail = `第 ${quote.turn ?? "?"} 轮 · ${quote.role === "user" ? "用户" : "agent"}`;
        pushOccurrence(attachRows, `quote:${itemTurn}:${quote.text}`, { kind: "quote", label: `「${clampLabel(quote.text)}」`, detail, count: 1 }, { turn: itemTurn, gone, tokens: estimateContextTokens(quote.text) });
      }
      for (const token of findInvocationTokens(text)) {
        // 指令块（<mentioned_tools>）随消息进上下文，量级是一行点名指令
        if (token.kind === "skill") {
          pushOccurrence(skillRows, `invoked:${token.target}`, { name: token.target, how: "invoked" }, { turn: itemTurn, gone, tokens: estimateContextTokens(`- ${token.target} — read the skill file before anything else`) });
        } else {
          pushOccurrence(mcpRows, `invoked:${token.target}`, { server: token.target, tool: "", query: null }, { turn: itemTurn, gone, tokens: estimateContextTokens(`- use the MCP server ${token.target}`) });
        }
      }
      // 旧格式的 <skill> 块（2026-10-02 句中展开时代的存量）
      const legacy = parseSkillSegments(text);
      if (legacy !== null) {
        for (const segment of legacy) {
          if (segment.kind !== "skill") continue;
          pushOccurrence(skillRows, `invoked:${segment.name}`, { name: segment.name, how: "invoked" }, { turn: itemTurn, gone, tokens: estimateContextTokens(segment.content) });
        }
      }
      continue;
    }

    if (record.role !== "tool") continue;
    const occurrence: Occurrence = { turn: itemTurn, gone, tokens: toolContentTokens(record.content) };
    const name = record.toolName;
    const params: unknown = record.input;

    if (name === "read" || name === "read_pdf" || name === "read_docx") {
      const path = stringField(params, "path");
      if (path === undefined) continue;
      const normalized = normalizeSeparators(path);
      // SKILL.md 的读取是「技能按需加载」，归技能组不归文件组（同一个调用不双记）
      const skillMatch = SKILL_MD_TAIL.exec(normalized);
      if (skillMatch !== null) {
        const slug = skillMatch[2] ?? "";
        pushOccurrence(skillRows, `read:${slug.toLowerCase()}`, { name: slug, how: "read" }, occurrence);
        continue;
      }
      const range = name === "read_pdf" ? pdfRangeLabel(params) : readRangeLabel(params);
      const key = `file:${normalized}`;
      const existing = fileRows.get(key);
      if (existing === undefined) {
        const shown = displayPath(cwd, path);
        pushOccurrence(fileRows, key, { path: shown.display, name: pathTail(normalized), outside: shown.outside, ranges: [range] }, occurrence);
      } else {
        existing.occurrences.push(occurrence);
        if (!existing.display.ranges.includes(range)) existing.display.ranges.push(range);
      }
      continue;
    }

    if (name === "grep" || name === "find" || name === "ls") {
      const existing = searchNotes.get(name);
      if (existing === undefined) searchNotes.set(name, { occurrences: [occurrence], tool: name });
      else existing.occurrences.push(occurrence);
      continue;
    }

    if (name === "browser_navigate") {
      const details = detailsRecord(record);
      const cardUrl = cardField(details, "browser", "url");
      const cardTitle = cardField(details, "browser", "title");
      const rawUrl = stringField(params, "url");
      // back / forward 不开新页：结果卡给的是到达页（有卡就算一行），没卡只把
      // 结果 token 记到当前页——浏览器组的量不该因翻页动作而漏计
      const isHistory = rawUrl !== undefined && ["back", "forward"].includes(rawUrl.trim().toLowerCase());
      const url = cardUrl ?? (isHistory ? undefined : rawUrl);
      if (url !== undefined) {
        const key = url;
        currentPageKey = key;
        const existing = webRows.get(key);
        const display = { url, title: cardTitle ?? existing?.display.title ?? null, domain: hostnameOf(url) };
        pushOccurrence(webRows, key, existing === undefined ? display : existing.display, occurrence);
      } else if (currentPageKey !== null) {
        const existing = webRows.get(currentPageKey);
        if (existing !== undefined) existing.occurrences.push(occurrence);
      }
      continue;
    }
    if (name.startsWith("browser_")) {
      // 其余浏览器工具作用于当前页：不另开行，结果 token 记到当前页那行的出现上
      if (currentPageKey !== null) {
        const existing = webRows.get(currentPageKey);
        if (existing !== undefined) existing.occurrences.push(occurrence);
      }
      continue;
    }

    if (name === "read_task") {
      const task = stringField(params, "task") ?? "";
      const rounds = stringField(params, "rounds");
      const details = detailsRecord(record);
      const title = cardField(details, "readTask", "title");
      const key = `task:${task}`;
      const existing = taskRows.get(key);
      if (existing === undefined) {
        pushOccurrence(taskRows, key, { ref: task, title: title ?? null, external: task.startsWith("ext:"), catalog: task === "", rounds: rounds === undefined ? null : [rounds] }, occurrence);
      } else {
        existing.occurrences.push(occurrence);
        existing.display = {
          ...existing.display,
          title: title ?? existing.display.title,
          rounds: rounds === undefined ? existing.display.rounds : [...(existing.display.rounds ?? []), rounds],
        };
      }
      continue;
    }

    const qualified = parseQualifiedToolName(name);
    if (qualified !== null) {
      const query =
        stringField(params, "query") ??
        stringField(params, "search_query") ??
        stringField(params, "q") ??
        stringField(params, "text") ??
        null;
      const key = `mcp:${qualified.server}__${qualified.tool}`;
      const existing = mcpRows.get(key);
      if (existing === undefined) {
        pushOccurrence(mcpRows, key, { server: qualified.server, tool: qualified.tool, query }, occurrence);
      } else {
        existing.occurrences.push(occurrence);
        existing.display = { ...existing.display, query: query ?? existing.display.query };
      }
    }
  }

  // —— 规则组：事件清单原样转视图（估算已在产出方做好） ——
  const rules =
    input.rules === undefined || input.rules === null
      ? null
      : {
          files: input.rules.files.map((file) => ({ path: file.path, name: pathTail(normalizeSeparators(file.path)) || file.path, scope: file.scope, tokens: file.tokens })),
          baseTokens: input.rules.baseTokens,
          skillsIndex: { names: [...input.rules.skillsIndex.names], tokens: input.rules.skillsIndex.tokens },
          segments: input.rules.segments.map((segment) => ({ id: segment.id, tokens: segment.tokens })),
          tokens: input.rules.baseTokens + input.rules.segments.reduce((sum, segment) => sum + segment.tokens, 0),
        };

  // —— 裁剪与组装：scope = turn 只留当前轮的出现 ——
  const scoped = <T extends { occurrences: Occurrence[] }>(accum: T): Occurrence[] =>
    scope === "task" ? accum.occurrences : accum.occurrences.filter((occ) => occ.turn === currentTurn);

  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

  const attach: ContextAttachRow[] = [];
  for (const accum of attachRows.values()) {
    const occs = scoped(accum);
    if (occs.length === 0) continue;
    const first = occs[0];
    if (first === undefined) continue;
    // 文件引用的 count = 视野内出现次数；其余（图片张数 / 单条引用）用显示值
    const count = accum.display.kind === "file-ref" ? occs.length : accum.display.count;
    attach.push({ turn: first.turn, gone: occs.every((occ) => occ.gone), tokens: sum(occs.map((occ) => occ.tokens)), ...accum.display, count });
  }

  const fileRowList: ContextFileRow[] = [];
  for (const accum of fileRows.values()) {
    const occs = scoped(accum);
    if (occs.length === 0) continue;
    const first = occs[0];
    if (first === undefined) continue;
    fileRowList.push({ turn: first.turn, gone: occs.every((occ) => occ.gone), tokens: sum(occs.map((occ) => occ.tokens)), ...accum.display });
  }

  const searches: ContextSearchNote[] = [];
  for (const note of searchNotes.values()) {
    const occs = scoped(note);
    if (occs.length === 0) continue;
    const first = occs[0];
    if (first === undefined) continue;
    searches.push({ tool: note.tool, count: occs.length, turn: first.turn, gone: occs.every((occ) => occ.gone), tokens: sum(occs.map((occ) => occ.tokens)) });
  }

  const webRowsFinal: ContextWebRow[] = [];
  for (const accum of webRows.values()) {
    const occs = scoped(accum);
    if (occs.length === 0) continue;
    const first = occs[0];
    if (first === undefined) continue;
    webRowsFinal.push({ turn: first.turn, gone: occs.every((occ) => occ.gone), tokens: sum(occs.map((occ) => occ.tokens)), ...accum.display });
  }

  const taskRowsFinal: ContextTaskRow[] = [];
  for (const accum of taskRows.values()) {
    const occs = scoped(accum);
    if (occs.length === 0) continue;
    const first = occs[0];
    if (first === undefined) continue;
    taskRowsFinal.push({ turn: first.turn, gone: occs.every((occ) => occ.gone), tokens: sum(occs.map((occ) => occ.tokens)), ...accum.display });
  }

  const mcpRowsFinal: ContextMcpRow[] = [];
  for (const accum of mcpRows.values()) {
    const occs = scoped(accum);
    if (occs.length === 0) continue;
    const first = occs[0];
    if (first === undefined) continue;
    mcpRowsFinal.push({ turn: first.turn, gone: occs.every((occ) => occ.gone), tokens: sum(occs.map((occ) => occ.tokens)), calls: occs.length, ...accum.display });
  }

  const skillRowsFinal: ContextSkillRow[] = [];
  for (const accum of skillRows.values()) {
    const occs = scoped(accum);
    if (occs.length === 0) continue;
    const first = occs[0];
    if (first === undefined) continue;
    skillRowsFinal.push({ turn: first.turn, gone: occs.every((occ) => occ.gone), tokens: sum(occs.map((occ) => occ.tokens)), ...accum.display });
  }

  // 文件组按目录归组（目录保首次出现顺序；cwd 根的 "." 排最前）
  const dirMap = new Map<string, ContextFileDir>();
  for (const row of fileRowList) {
    const dir = directoryOf(row.path);
    const key = row.outside ? `outside:${dir}` : `inside:${dir}`;
    const existing = dirMap.get(key);
    if (existing === undefined) {
      dirMap.set(key, { dir, outside: row.outside, rows: [row], tokens: row.tokens });
    } else {
      existing.rows.push(row);
      existing.tokens += row.tokens;
    }
  }
  const dirs = [...dirMap.values()].sort((a, b) => {
    if (a.dir === "." && b.dir !== ".") return -1;
    if (b.dir === "." && a.dir !== ".") return 1;
    return 0;
  });

  return {
    scope,
    currentTurn,
    compactions,
    rules,
    attach: { rows: attach, tokens: sum(attach.map((row) => row.tokens)) },
    files: { dirs, searches, tokens: sum(fileRowList.map((row) => row.tokens)) + sum(searches.map((note) => note.tokens)) },
    web: { rows: webRowsFinal, tokens: sum(webRowsFinal.map((row) => row.tokens)) },
    tasks: { rows: taskRowsFinal, tokens: sum(taskRowsFinal.map((row) => row.tokens)) },
    mcp: { rows: mcpRowsFinal, tokens: sum(mcpRowsFinal.map((row) => row.tokens)) },
    skills: { rows: skillRowsFinal, tokens: sum(skillRowsFinal.map((row) => row.tokens)) },
  };
}
