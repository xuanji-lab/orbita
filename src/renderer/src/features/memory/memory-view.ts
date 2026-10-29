/**
 * 记忆界面（审查面板 › 记忆页签、记忆库页）的数据整形——纯函数，node:test 直接测。
 * 分组顺序、筛选与搜索的口径都在这里定，组件只管画。
 */
import { MEMORY_MUTED_REVERTED, MEMORY_USER_TOKEN } from "../../../../shared/memory.ts";
import type {
  MemoryEntry,
  MemoryScopeSummary,
  MemoryEntryType,
  MemoryEntryView,
  MemorySessionView,
  MemorySource,
} from "../../../../shared/memory.ts";

/**
 * 记忆库里三类的展示顺序：偏好最常被改、最影响下一次怎么做，放最前；
 * 经验次之；事实最多也最稳，放最后。
 */
export const MEMORY_TYPE_ORDER: readonly MemoryEntryType[] = ["preference", "insight", "fact"];

export type MemoryTypeFilter = "all" | MemoryEntryType;
export type MemorySourceFilter = "all" | MemorySource;

/** 记忆库「来源」分段的顺序：对话整理、agent 修订（对话里按用户纠正改的）、手动添加。 */
export const MEMORY_SOURCE_FILTERS: readonly MemorySourceFilter[] = ["all", "chat", "agent", "manual"];

export interface MemoryFilter {
  type: MemoryTypeFilter;
  source: MemorySourceFilter;
  /** 搜索词：空白分开的多个词都要命中（大小写不敏感）；空 = 不过滤 */
  query: string;
}

/** 搜索命中的文本面：正文、理由 / 依据、原话、出处会话标题、关键词。 */
function haystackOf(view: MemoryEntryView): string {
  const { entry } = view;
  return [entry.text, entry.reason ?? "", view.quote ?? "", view.sessionTitle ?? "", entry.keywords.join(" ")]
    .join("\n")
    .toLowerCase();
}

/** 按类型、来源、搜索词过滤；顺序保持主进程给的顺序（新在前）。 */
export function filterMemoryEntries(items: readonly MemoryEntryView[], filter: MemoryFilter): MemoryEntryView[] {
  const needles = filter.query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  return items.filter((view) => {
    if (filter.type !== "all" && view.entry.type !== filter.type) return false;
    if (filter.source !== "all" && view.entry.source !== filter.source) return false;
    if (needles.length === 0) return true;
    const haystack = haystackOf(view);
    return needles.every((needle) => haystack.includes(needle));
  });
}

/** 按 MEMORY_TYPE_ORDER 分组；没有条目的类型不出组。 */
export function groupMemoryEntries(
  items: readonly MemoryEntryView[],
): { type: MemoryEntryType; items: MemoryEntryView[] }[] {
  return MEMORY_TYPE_ORDER.map((type) => ({ type, items: items.filter((view) => view.entry.type === type) })).filter(
    (group) => group.items.length > 0,
  );
}

/** 审查页签按轮倒序（最新的轮在上）；只列「记住了东西」的轮——页签只管产出，用到的去上下文面板。 */
export function rememberedTurns(view: MemorySessionView | null): MemorySessionView["turns"] {
  if (view === null) return [];
  return [...view.turns].filter((row) => row.remembered.length > 0).sort((a, b) => b.turn - a.turn);
}

/** 随对话回退停用的条目（「回到这里」撤回了它的全部来源轮；恢复使用后不再算）。 */
export function isRevertMuted(entry: MemoryEntry): boolean {
  return entry.status === "muted" && entry.mutedReason === MEMORY_MUTED_REVERTED;
}

/**
 * 对话里「记忆 · 记住 M 条」行的条目：去掉随回退停用的。回退后重说的那一轮与被撤回的
 * 那一轮同一个轮号，不去掉的话新气泡下会挂着已撤回那几轮记下的东西；它们在审查 › 记忆
 * 页签与记忆库里照常可见（带标签、可恢复）。
 */
export function liveRemembered(row: MemorySessionView["turns"][number]): MemorySessionView["turns"][number] {
  const kept = row.remembered.filter((view) => !isRevertMuted(view.entry));
  return kept.length === row.remembered.length ? row : { ...row, remembered: kept };
}

/**
 * 召回发生在用户消息落进 pi 本子之前（轮前同步等记忆，最多 4–6 秒），所以账本里
 * 一轮的 `at` 会略早于那条用户消息的时间戳。按时间配对时给这么多余量。
 */
const RECALL_LEAD_MS = 10_000;

/**
 * 对话里每条用户消息对应记忆账本的哪一轮（「记忆 · 用到 N 条」行要挂在哪条气泡下）。
 *
 * **按时间配，不按计数**：一轮归给「时间不晚于它 + 余量」的最后一条用户消息，且不能
 * 越过下一条消息。计数（第 k 条用户消息 = 第 k 轮）只在 renderer 手上是完整历史时才对，
 * 而它常常不是：只加载了最近一页，或会话在后台跑（没打开时收到的实时事件只建出
 * 那几轮）——2026-10-29 实例 memui 实测，后台跑的第 7、8 轮被计数配成第 1、2 轮，
 * 气泡下挂了别的轮的账。账本的 `at` 与消息时间戳相差在一秒内，时间配两种情况都对。
 */
export function pairMemoryTurns(
  users: readonly { id: string; timestamp: number }[],
  view: MemorySessionView | null,
): Map<string, MemorySessionView["turns"][number]> {
  const paired = new Map<string, MemorySessionView["turns"][number]>();
  if (view === null || users.length === 0) return paired;
  const ordered = [...users].sort((a, b) => a.timestamp - b.timestamp);
  const gapOf = new Map<string, number>();
  for (const row of view.turns) {
    let owner: { id: string; timestamp: number } | null = null;
    for (let index = 0; index < ordered.length; index += 1) {
      const user = ordered[index]!;
      if (user.timestamp - RECALL_LEAD_MS > row.at) break;
      const next = ordered[index + 1];
      if (next === undefined || next.timestamp - RECALL_LEAD_MS > row.at) owner = user;
    }
    if (owner === null) continue;
    // 同一条消息被两轮争时留时间最贴近它的：一轮的召回就在它自己那条消息前几秒。
    // 会争的是「自己的气泡已不在」的轮——被「回到这里」撤回的轮（账本还在，时间落在
    // 回退点前一条消息之后）、或刚开轮回显还没到的那一轮；旧规则「留轮号大的」会让它们
    // 顶掉前一条消息自己的那一轮。等距时再按轮号大的
    const gap = Math.abs(row.at - owner.timestamp);
    const existing = paired.get(owner.id);
    const existingGap = gapOf.get(owner.id) ?? Number.POSITIVE_INFINITY;
    if (existing === undefined || gap < existingGap || (gap === existingGap && existing.turn < row.turn)) {
      paired.set(owner.id, row);
      gapOf.set(owner.id, gap);
    }
  }
  return paired;
}

/**
 * 条目卡上的撤销入口（没有「待你确认」之后，agent 判断错了就靠它们撤）。只在当前
 * 确实可撤时给，免得按了回一句「没有可撤的」：
 * - restorePrevious：这条顶掉了旧说法（conflictWith），旧条在演变链里还是「已过时」，
 *   且这条还在用——撤一次后旧条回 active、这条 muted，入口自然消失；
 * - returnToWorkspace：自动记到所有工作区（promotedFrom）且还在 user 层。
 */
export function memoryUndoActions(view: MemoryEntryView): { restorePrevious: boolean; returnToWorkspace: boolean } {
  const { entry } = view;
  const previous =
    entry.conflictWith === undefined ? undefined : view.evolution.find((node) => node.id === entry.conflictWith);
  return {
    restorePrevious: (entry.status ?? "active") === "active" && previous?.status === "stale",
    returnToWorkspace: entry.layer === "user" && entry.promotedFrom !== undefined,
  };
}

/** 手动添加的校验：正文必填；偏好 / 经验必须写理由（服务侧同样会拒，这里先挡住给出原因）。 */
export function manualDraftProblem(draft: {
  type: MemoryEntryType;
  text: string;
  reason: string;
}): "text" | "reason" | null {
  if (draft.text.trim() === "") return "text";
  if (draft.type !== "fact" && draft.reason.trim() === "") return "reason";
  return null;
}

/**
 * 记忆库页的导航位置（侧栏在记忆库盖层下换成这份导航，与设置页同一种整页形态）：
 * 某个范围的条目（"all" = 全部）、向量模型。
 */
export type MemoryNav = { kind: "scope"; token: string } | { kind: "vector" };

/**
 * 作用域 token → 显示名。user 层（所有工作区）的名字用界面语言的文案——服务给的
 * name 是写死的中文；工作区 / Home 是专名，照服务给的显示。拿不到就用 userName。
 */
export function scopeNameOf(scopes: readonly MemoryScopeSummary[] | null, token: string, userName: string): string {
  if (token === MEMORY_USER_TOKEN) return userName;
  const scope = scopes?.find((item) => item.token === token);
  return scope === undefined || scope.kind === "user" ? userName : scope.name;
}
