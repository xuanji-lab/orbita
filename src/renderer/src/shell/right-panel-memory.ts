import type { RightPanelKind } from "./RightRail.tsx";
// 只要类型：RightPanelKind 是纯类型别名，`node --test` 的原生剥离会把整条 import
// 连同这一行一起删掉，不会真的去加载 RightRail.tsx（那份文件带 JSX，Node 的类型
// 剥离不认）——同 tree-view.ts 引 IconName 的先例。
import type { TaskPanelTab } from "../features/context/ContextPanel.tsx";
import type { AutomationScope } from "../features/automation/automation-view.ts";
import type { ReviewSource } from "../../../shared/review.ts";
import type { ContextScope } from "../../../shared/context-inventory.ts";
import type { ContextGroupKey } from "../features/context/context-panel-view.ts";
import { CONTEXT_GROUPS } from "../features/context/context-panel-view.ts";
import { isReviewSource } from "../../../shared/review.ts";
import { RIGHT_PANEL_MEMORY_MAX_ENTRIES, type RightPanelMemoryFile } from "../../../shared/right-panel-memory.ts";
import type { WsFilter } from "./workspace-filter.ts";

/**
 * 右栏面板的**按会话记忆**（用户 2026-10-18：「每个 session，应该记住自己离开的
 * 时候，右侧面板是啥」；2026-11-07：「这个树节点要往下探呀」）。
 *
 * 每条主槽会话记一条**路径**：开着哪个面板（或「关着」），再往下一层——面板自己
 * 报上来的 `sub`（进了哪个插件 / 哪条自动化 / 哪个页签……）。切回来时面板从那一层
 * 打开；没记过的会话恢复成「关着」。
 *
 * 边界：
 * - `sub` 的形状由各面板定义，**纯数据、可 JSON 序列化**，只放「在哪一层」，不放内容；
 * - 文件面板的标签、终端、辅助对话**不记第二层**：文件面板「切会话清标签」是 2026-10-18
 *   定的，终端与辅助对话的状态全局共用；
 * - 一次性信号（「/ + 空格」选取态、对话卡的定位请求）不记；
 * - 读回来的数据不可信（文件可能被手改，或来自旧版本）：每个字段都在 parse 里校验，
 *   对不上的丢掉；指向已不存在的插件 / 自动化 / 子会话的，面板拿活数据再核一次，退回列表；
 * - 首页 / 还没有会话（session 为 null）不是会话：不记也不恢复；
 * - 右栏宽度仍全局共用一个，不按会话分。
 *
 * 纯函数住独立模块（同 cite-focus.ts 的做法）：记忆的取舍规则在这里可直测，
 * App 只留「变了就记、切回就取」的编排。
 */

// ── 各面板的第二层（sub）──────────────────────────────────────────────
// 约定：与默认值相同的字段一律不写（规范形），空 sub 就是 undefined——
// 这样「没动过」与「回到了列表」是同一个值，比较与落盘都不用再猜。

/** 能力（plugins）面板：进了哪个插件 / 技能 / MCP 的详情、是否在看板视图、选择条的档、正在看的草稿 */
export interface PluginsSub {
  /** 详情里的那一项（PluginView.id）；没有 = 列表 */
  selected?: string;
  /** 在详情的看板视图里（只在 selected 有值时有意义） */
  board?: true;
  /** 工作区选择条选的档；没有 = 默认（当前会话所在的工作区） */
  ws?: WsFilter;
  /** 用户点开的「正在做」草稿（长页）；agent 预览出来的草稿不记，它本来就按会话挂在 App 里 */
  draft?: { path: string; workspaceId: string | null };
}

/** 自动化面板：看哪一条的详情、范围。编辑页（表单里有未保存的字）不记，退回它来源的那一层 */
export interface AutomationSub {
  /** 详情里的那一条自动化 id；没有 = 列表 */
  detail?: string;
  /** 范围；默认 "workspace"（本工作区），只记 "all" */
  scope?: "all";
}

/** 审查面板：页签、来源。展开的文件不记 */
export interface ReviewSub {
  /** 默认 "changes"（改动） */
  tab?: "excerpts" | "memory";
  /** 默认 "task" */
  source?: Exclude<ReviewSource, "task">;
}

/** 「这条任务」面板的上下文页签：视野、折叠的组。进度 / 上下文页签本身记在 entry.taskTab 上 */
export interface ContextSub {
  /** 默认 "turn"（本轮） */
  scope?: "task";
  /** 折叠的组；默认只折叠 rules。给了就是完整列表（可以是空数组 = 全展开） */
  collapsed?: ContextGroupKey[];
}

/** 子会话面板：会话层里打开的那一条子会话；没有 = 列表 */
export interface SubSessionsSub {
  sessionId: string;
}

/** 意图面板：看的哪一轮、视图。选中的节点不记 */
export interface IntentSub {
  /** 轮次编号（1 起）；没有 = 全部轮 */
  round?: number;
  /** 默认 "slots" */
  view?: "questions";
}

/** 路径：开着哪个面板，再往下一层。带 sub 的面板才有 sub 字段，其余只有 panel */
export type PanelPath =
  | { panel: null }
  | { panel: "files" | "terminal" | "drawer" }
  | { panel: "plugins"; sub?: PluginsSub }
  | { panel: "automation"; sub?: AutomationSub }
  | { panel: "review"; sub?: ReviewSub }
  | { panel: "context"; sub?: ContextSub }
  | { panel: "subsessions"; sub?: SubSessionsSub }
  | { panel: "intent"; sub?: IntentSub };

/** 一条会话的记忆：路径，外加「这条任务」面板上次停在哪个页签（面板关着也记，重开仍在那一页） */
export type PanelEntry = PanelPath & {
  /** 默认 "progress"，只记 "context" */
  taskTab?: "context";
};

/** 会话 id → 它的记忆。**Map 的迭代顺序 = 最近用过的在最后**（rememberEntry 每次先删再放），上限淘汰就吃这个顺序 */
export type PanelMemory = ReadonlyMap<string, PanelEntry>;

/** 没记过的会话：关着 */
export const CLOSED_ENTRY: PanelEntry = { panel: null };

/** 有第二层的面板（其余面板切会话时不重挂，见 App 的 key） */
export type SubPanelKind = "plugins" | "automation" | "review" | "context" | "subsessions" | "intent";
const SUB_PANELS: ReadonlySet<RightPanelKind> = new Set<RightPanelKind>(["plugins", "automation", "review", "context", "subsessions", "intent"]);
export function hasSubLayer(panel: RightPanelKind | null): panel is SubPanelKind {
  return panel !== null && SUB_PANELS.has(panel);
}

// ── 记 / 取 / 淘汰 ───────────────────────────────────────────────────

/**
 * 记下一条会话此刻的记忆。session 为 null（首页 / 还没有会话）时原样返回。
 * 内容没变就原样返回（引用不变：调用方据此跳过落盘）；变了或新增，条目挪到「最近」末尾，超上限淘汰最旧的。
 */
export function rememberEntry(memory: PanelMemory, session: string | null, entry: PanelEntry): PanelMemory {
  if (session === null) return memory;
  const old = memory.get(session);
  if (old !== undefined && sameEntry(old, entry) && lastKey(memory) === session) return memory;
  const next = new Map(memory);
  next.delete(session);
  next.set(session, entry);
  while (next.size > RIGHT_PANEL_MEMORY_MAX_ENTRIES) {
    const oldest = next.keys().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

function lastKey(memory: PanelMemory): string | undefined {
  let last: string | undefined;
  for (const key of memory.keys()) last = key;
  return last;
}

/** 一条会话该恢复成什么：没记过（从没开过右栏 / 新会话）与 session 为 null 都恢复成关着 */
export function recallEntry(memory: PanelMemory, session: string | null): PanelEntry {
  if (session === null) return CLOSED_ENTRY;
  return memory.get(session) ?? CLOSED_ENTRY;
}

/** 这条会话在本次运行里记过没有（「和智能体一起做一个」的 carry 只给从没记过的新会话） */
export function hasEntry(memory: PanelMemory, session: string | null): boolean {
  return session !== null && memory.has(session);
}

/** 会话被删了：清掉不在 alive 里的条目。没有要清的就原样返回 */
export function forgetMissing(memory: PanelMemory, alive: ReadonlySet<string>): PanelMemory {
  let dead = false;
  for (const key of memory.keys()) {
    if (!alive.has(key)) {
      dead = true;
      break;
    }
  }
  if (!dead) return memory;
  const next = new Map<string, PanelEntry>();
  for (const [key, entry] of memory) if (alive.has(key)) next.set(key, entry);
  return next;
}

export function sameEntry(a: PanelEntry, b: PanelEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── 面板自己报上来的 sub：规范化 ───────────────────────────────────────

/** 规范形：空对象 → undefined；与默认值相同的字段在各 parse 里已丢掉 */
function nonEmpty<T extends object>(value: T): T | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** 一个 id / 路径类字符串：非空、不超长（防手改的文件塞进巨字符串） */
function shortString(raw: unknown, max = 600): string | undefined {
  return typeof raw === "string" && raw !== "" && raw.length <= max ? raw : undefined;
}

function parseWsFilter(raw: unknown): WsFilter | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "all" || raw.kind === "tasks" || raw.kind === "global") return { kind: raw.kind };
  if (raw.kind === "workspace") {
    const id = shortString(raw.id);
    return id === undefined ? undefined : { kind: "workspace", id };
  }
  return undefined;
}

export function parsePluginsSub(raw: unknown): PluginsSub | undefined {
  if (!isRecord(raw)) return undefined;
  const out: PluginsSub = {};
  const selected = shortString(raw.selected);
  if (selected !== undefined) {
    out.selected = selected;
    if (raw.board === true) out.board = true;
  }
  const ws = parseWsFilter(raw.ws);
  if (ws !== undefined) out.ws = ws;
  if (isRecord(raw.draft)) {
    const path = shortString(raw.draft.path, 2000);
    const workspaceId = raw.draft.workspaceId === null ? null : shortString(raw.draft.workspaceId);
    if (path !== undefined && workspaceId !== undefined) out.draft = { path, workspaceId };
  }
  return nonEmpty(out);
}

export function parseAutomationSub(raw: unknown): AutomationSub | undefined {
  if (!isRecord(raw)) return undefined;
  const out: AutomationSub = {};
  const detail = shortString(raw.detail);
  if (detail !== undefined) out.detail = detail;
  if (raw.scope === "all") out.scope = "all";
  return nonEmpty(out);
}

export function parseReviewSub(raw: unknown): ReviewSub | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ReviewSub = {};
  if (raw.tab === "excerpts" || raw.tab === "memory") out.tab = raw.tab;
  if (isReviewSource(raw.source) && raw.source !== "task") out.source = raw.source;
  return nonEmpty(out);
}

/** 上下文页签「折叠的组」的默认：只折叠规则组（量大但最少需要看） */
export const DEFAULT_COLLAPSED: readonly ContextGroupKey[] = ["rules"];

export function parseContextSub(raw: unknown): ContextSub | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ContextSub = {};
  if (raw.scope === "task") out.scope = "task";
  if (Array.isArray(raw.collapsed)) {
    // 只认已知的组、去重，按显示顺序排成规范形
    const keys = CONTEXT_GROUPS.filter((key) => (raw.collapsed as unknown[]).includes(key));
    if (!(keys.length === DEFAULT_COLLAPSED.length && keys.every((key, index) => key === DEFAULT_COLLAPSED[index]))) out.collapsed = keys;
  }
  return nonEmpty(out);
}

export function parseSubSessionsSub(raw: unknown): SubSessionsSub | undefined {
  if (!isRecord(raw)) return undefined;
  const sessionId = shortString(raw.sessionId);
  return sessionId === undefined ? undefined : { sessionId };
}

export function parseIntentSub(raw: unknown): IntentSub | undefined {
  if (!isRecord(raw)) return undefined;
  const out: IntentSub = {};
  if (typeof raw.round === "number" && Number.isInteger(raw.round) && raw.round >= 1 && raw.round <= 100_000) out.round = raw.round;
  if (raw.view === "questions") out.view = "questions";
  return nonEmpty(out);
}

// ── 一条记忆：解析 / 规范化 ────────────────────────────────────────────

const PLAIN_PANELS = ["files", "terminal", "drawer"] as const;

/** 规范化一条路径（面板报上来的、文件里读回来的都走它）。panel 不认识 → null（整条丢） */
export function parsePath(raw: unknown): PanelPath | null {
  if (!isRecord(raw)) return null;
  const { panel } = raw;
  if (panel === null) return { panel: null };
  if (typeof panel !== "string") return null;
  if ((PLAIN_PANELS as readonly string[]).includes(panel)) return { panel: panel as (typeof PLAIN_PANELS)[number] };
  if (panel === "plugins") return withSub("plugins", parsePluginsSub(raw.sub));
  if (panel === "automation") return withSub("automation", parseAutomationSub(raw.sub));
  if (panel === "review") return withSub("review", parseReviewSub(raw.sub));
  if (panel === "context") return withSub("context", parseContextSub(raw.sub));
  if (panel === "subsessions") return withSub("subsessions", parseSubSessionsSub(raw.sub));
  if (panel === "intent") return withSub("intent", parseIntentSub(raw.sub));
  return null;
}

function withSub<K extends SubPanelKind>(panel: K, sub: unknown): PanelPath {
  // sub 缺席时不带 sub 字段（规范形）。类型在上面的 parse* 里已定，这里只拼
  return (sub === undefined ? { panel } : { panel, sub }) as PanelPath;
}

/** 规范化一条记忆。旧格式（只有面板种类的字符串）也认：当作没有第二层 */
export function parseEntry(raw: unknown): PanelEntry | null {
  const path = typeof raw === "string" || raw === null ? parsePath({ panel: raw }) : parsePath(raw);
  if (path === null) return null;
  if (isRecord(raw) && raw.taskTab === "context") return { ...path, taskTab: "context" };
  return path;
}

// ── 落盘 ──────────────────────────────────────────────────────────────

/**
 * 读回上次的记忆（不可信）：逐条校验，坏条目丢掉，旧 → 新顺序保持，超上限留最新的。
 * 条目形状 `{ id, panel, sub?, taskTab? }`；也认旧的 `[id, panel]` 二元组。
 */
export function parseMemoryFile(file: RightPanelMemoryFile | null): PanelMemory {
  if (file === null) return new Map();
  let memory: PanelMemory = new Map();
  for (const raw of file.entries) {
    let id: string | undefined;
    let entry: PanelEntry | null = null;
    if (Array.isArray(raw) && raw.length === 2) {
      id = shortString(raw[0]);
      entry = parseEntry(raw[1]);
    } else if (isRecord(raw)) {
      id = shortString(raw.id);
      entry = parseEntry(raw);
    }
    if (id === undefined || entry === null) continue;
    memory = rememberEntry(memory, id, entry);
  }
  return memory;
}

/** 落盘的形状：旧 → 新。关着且没有页签偏好的条目不落盘（读回来本来就是「关着」，不值得占一行） */
export function toMemoryFile(memory: PanelMemory): RightPanelMemoryFile {
  const entries: unknown[] = [];
  for (const [id, entry] of memory) {
    if (entry.panel === null && entry.taskTab === undefined) continue;
    entries.push({ id, ...entry });
  }
  return { version: 1, entries };
}

/** 合并「读回的旧记忆」与「本次运行里已记下的」：本次的优先，也排在更「新」的一侧 */
export function mergeLoaded(loaded: PanelMemory, current: PanelMemory): PanelMemory {
  let merged = loaded;
  for (const [id, entry] of current) merged = rememberEntry(merged, id, entry);
  return merged;
}

// ── 拿活数据再核一次（读回来的路径可能指向已不存在的东西）────────────────

/** 能力面板：详情 / 看板指向的那一项不在列表里（已卸载 / 已删）→ 回列表；选择条的档由 resolveFilter 兜底 */
export function resolvePluginsSub(sub: PluginsSub | undefined, knownIds: ReadonlySet<string> | null): PluginsSub | undefined {
  if (sub === undefined || sub.selected === undefined || knownIds === null || knownIds.has(sub.selected)) return sub;
  const { selected: _selected, board: _board, ...rest } = sub;
  return nonEmpty(rest);
}

/** 自动化面板：详情指向的那一条不在了 → 回列表 */
export function resolveAutomationSub(sub: AutomationSub | undefined, knownIds: ReadonlySet<string> | null): AutomationSub | undefined {
  if (sub === undefined || sub.detail === undefined || knownIds === null || knownIds.has(sub.detail)) return sub;
  const { detail: _detail, ...rest } = sub;
  return nonEmpty(rest);
}

/** 子会话面板：打开的那条不是这个主会话的子会话（已删 / 挂错了母亲）→ 列表 */
export function resolveSubSessionsSub(sub: SubSessionsSub | undefined, childIds: ReadonlySet<string> | null): SubSessionsSub | undefined {
  if (sub === undefined || childIds === null || childIds.has(sub.sessionId)) return sub;
  return undefined;
}

/** 自动化：面板内部 view 与范围 ↔ sub */
export function automationSubOf(detailId: string | null, scope: AutomationScope): AutomationSub | undefined {
  const out: AutomationSub = {};
  if (detailId !== null) out.detail = detailId;
  if (scope === "all") out.scope = "all";
  return nonEmpty(out);
}

/** 审查：页签 / 来源 ↔ sub */
export function reviewSubOf(tab: "changes" | "excerpts" | "memory", source: ReviewSource): ReviewSub | undefined {
  const out: ReviewSub = {};
  if (tab !== "changes") out.tab = tab;
  if (source !== "task") out.source = source;
  return nonEmpty(out);
}

/** 上下文：视野 / 折叠的组 ↔ sub（折叠集与默认相同就不写） */
export function contextSubOf(scope: ContextScope, collapsed: ReadonlySet<ContextGroupKey>): ContextSub | undefined {
  return parseContextSub({ scope, collapsed: [...collapsed] });
}

/** 意图：轮次 / 视图 ↔ sub */
export function intentSubOf(round: number | null, view: "slots" | "questions"): IntentSub | undefined {
  return parseIntentSub({ ...(round === null ? {} : { round }), view });
}

/**
 * 此刻右栏的完整记忆条目（App 的写穿用）：面板报上来的路径 + App 自己持有的几块
 * （用户点开的草稿、子会话面板里打开的那条、「这条任务」页签）。
 * 路径里的 panel 与 rightPanel 不一致的是过期的（刚换面板、面板还没来得及报）：当作该面板的根。
 */
export function composeEntry(input: {
  rightPanel: RightPanelKind | null;
  path: PanelPath;
  openedDraft: { path: string; workspaceId: string | null } | null;
  subSessionId: string | null;
  taskTab: TaskPanelTab;
}): PanelEntry {
  const { rightPanel, path } = input;
  const reported: unknown = path.panel === rightPanel && "sub" in path ? path.sub : undefined;
  let raw: Record<string, unknown> = { panel: rightPanel };
  if (rightPanel === "plugins") {
    // 草稿只认 App 持有的 openedDraft：路径里带的（恢复时从记忆来的）是上一份，不再算数
    const { draft: _stale, ...rest } = isRecord(reported) ? reported : { draft: undefined };
    raw = { panel: rightPanel, sub: { ...rest, ...(input.openedDraft === null ? {} : { draft: input.openedDraft }) } };
  } else if (rightPanel === "subsessions") {
    raw = { panel: rightPanel, sub: input.subSessionId === null ? undefined : { sessionId: input.subSessionId } };
  } else if (hasSubLayer(rightPanel)) {
    raw = { panel: rightPanel, sub: reported };
  }
  const base = parsePath(raw) ?? CLOSED_ENTRY;
  return input.taskTab === "context" ? { ...base, taskTab: "context" } : base;
}

/** 「这条任务」页签 ↔ entry.taskTab */
export function taskTabOf(entry: PanelEntry): TaskPanelTab {
  return entry.taskTab === "context" ? "context" : "progress";
}
