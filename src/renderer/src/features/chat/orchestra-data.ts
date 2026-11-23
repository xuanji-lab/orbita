import type { SessionMeta } from "@shared/session";
import { ORCHESTRA_HOME_KEY } from "../../../../shared/settings.ts";
import type { SessionRunState } from "../notify/completion-notice.ts";

/**
 * 编排形态的数据（纯函数，可被 node --test 直接加载）：主对话指针、按天分组、右栏「编排」面板的树。
 *
 * **顶替说明**：旧内核这条线上没有常驻主智能体，也没有持久子智能体——
 * - 主智能体的对话 = 一条普通会话，指针记在 settings.orchestraMain（不写会话 meta）；
 * - 「子智能体」这一层先由主对话派出去的活（它的子会话）充当；
 * 内核那条线接入常驻主智能体后，这两处整块换掉。
 */

/** settings.orchestraMain 的键：工作区 id，「主目录」用固定键 */
export function orchestraKey(workspaceId: string | null): string {
  return workspaceId ?? ORCHESTRA_HOME_KEY;
}

/**
 * 这个工作区的主对话：指针指向的会话还在、是根会话、没归档、仍属于这个工作区才算；否则当作还没有
 * （下一句从 New Task 页发出时会新开一条并记成主对话）。
 */
export function mainConversationOf(
  sessions: readonly SessionMeta[],
  workspaceId: string | null,
  pointers: Readonly<Record<string, string>> | undefined,
): SessionMeta | null {
  const id = pointers?.[orchestraKey(workspaceId)];
  if (id === undefined) return null;
  const meta = sessions.find((each) => each.id === id);
  if (meta === undefined || meta.parentId !== undefined || meta.archived || meta.workspaceId !== workspaceId) return null;
  return meta;
}

// ── 按天 ────────────────────────────────────────────────────────────────

/** 本地日期键 YYYY-MM-DD（按天分隔与「会话」菜单按天回看共用） */
export function dayKeyOf(timestamp: number): string {
  const d = new Date(timestamp);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface DayGroup {
  day: string;
  /** 这一天第一条用户消息（「会话」菜单点了滚到它） */
  firstUserId: string;
  /** 这一天你说了几句 */
  count: number;
}

/**
 * 一条长对话按天分组（只看用户消息：一天里你说的第一句就是这一天的开头）。新的在前。
 * 只能分已加载的那一段——更早的在往上翻、翻页加载之后才出现（调用方在菜单尾说明）。
 */
export function daysOf(records: readonly { id: string; role: string; timestamp: number }[]): DayGroup[] {
  const byDay = new Map<string, DayGroup>();
  for (const record of records) {
    if (record.role !== "user") continue;
    const day = dayKeyOf(record.timestamp);
    const group = byDay.get(day);
    if (group === undefined) byDay.set(day, { day, firstUserId: record.id, count: 1 });
    else group.count += 1;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** 每天第一条用户消息的 id → 日期键：对话里在这些消息上方画一条日期分隔线 */
export function dayStartsOf(records: readonly { id: string; role: string; timestamp: number }[]): Map<string, string> {
  const starts = new Map<string, string>();
  let last: string | null = null;
  for (const record of records) {
    if (record.role !== "user") continue;
    const day = dayKeyOf(record.timestamp);
    if (day !== last) starts.set(record.id, day);
    last = day;
  }
  return starts;
}

/** 日期键相对今天：0 = 今天、1 = 昨天…（按本地日历日算，不按 24 小时） */
export function daysAgo(day: string, now: number): number {
  const [y, m, d] = day.split("-").map(Number);
  const then = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
  const today = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  return Math.round((today - then) / 86_400_000);
}

/** 日期键的显示：今天 / 昨天 / 「11月20日 周四」（本地格式，跨年带年份） */
export function dayLabel(day: string, now: number, words: { today: string; yesterday: string }, locale: string): string {
  const ago = daysAgo(day, now);
  if (ago === 0) return words.today;
  if (ago === 1) return words.yesterday;
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

// ── 树状图 ──────────────────────────────────────────────────────────────

/** 没动静的会话多久不碰就退出树（与星系的 IDLE_CHILD_MS 同档：3 天） */
export const TREE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;
/** 「会话」这一组最多列几条，其余折成「另有 N 条更早的会话」 */
export const TREE_SESSION_CAP = 24;
/** 一个节点下最多列几条子会话，其余折成「+N」 */
export const TREE_CHILD_CAP = 6;

export interface TreeNode {
  meta: SessionMeta;
  /** 这一行的状态（含子会话汇总，与侧栏状态饼同口径） */
  state: SessionRunState;
  children: TreeNode[];
  /** 超出 TREE_CHILD_CAP 没列的子会话数 */
  hiddenChildren: number;
  /** 有子会话在等你 / 在跑：默认展开 */
  activeBelow: boolean;
}

export interface OrchestraTree {
  /** 主对话（主智能体当前顶着的那条会话）；还没有为 null */
  main: SessionMeta | null;
  /** 派出去的活 = 主对话的子会话（充当子智能体这一层） */
  jobs: TreeNode[];
  /** 这个工作区里别的会话（不是主智能体派的） */
  sessions: TreeNode[];
  /** 没列出来的旧会话数（退场的 + 超出上限的） */
  older: number;
}

function live(state: SessionRunState): boolean {
  return state === "waiting" || state === "running";
}

/**
 * 树：根 = 主智能体；下一层 = 派出去的活 + 这个工作区的会话（名字 + 状态）；子会话再往下一层。
 * 次序只按创建时间（新的在前）——状态变化不让行换位置，只有内容增减才动。
 * 退场：没状态又 3 天没碰的会话不列（折进「另有 N 条」），在跑 / 等你 / 有结果没看的永远列。
 */
export function orchestraTree(input: {
  sessions: readonly SessionMeta[];
  workspaceId: string | null;
  mainId: string | null;
  stateOf: (meta: SessionMeta) => SessionRunState;
  now: number;
}): OrchestraTree {
  const childrenOf = new Map<string, SessionMeta[]>();
  for (const meta of input.sessions) {
    if (meta.parentId === undefined) continue;
    const list = childrenOf.get(meta.parentId);
    if (list === undefined) childrenOf.set(meta.parentId, [meta]);
    else list.push(meta);
  }
  const byNewest = (a: SessionMeta, b: SessionMeta): number => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  const node = (meta: SessionMeta): TreeNode => {
    const kids = [...(childrenOf.get(meta.id) ?? [])].sort(byNewest);
    const children = kids.slice(0, TREE_CHILD_CAP).map((child) => ({
      meta: child,
      state: input.stateOf(child),
      children: [],
      hiddenChildren: Math.max(0, (childrenOf.get(child.id)?.length ?? 0)),
      activeBelow: false,
    }));
    return {
      meta,
      state: input.stateOf(meta),
      children,
      hiddenChildren: Math.max(0, kids.length - TREE_CHILD_CAP),
      activeBelow: kids.some((child) => live(input.stateOf(child))),
    };
  };
  const main = input.mainId === null ? null : (input.sessions.find((meta) => meta.id === input.mainId) ?? null);
  const jobs = main === null ? [] : [...(childrenOf.get(main.id) ?? [])].sort(byNewest).map(node);
  const roots = input.sessions
    .filter(
      (meta) =>
        meta.parentId === undefined &&
        meta.workspaceId === input.workspaceId &&
        !meta.archived &&
        (meta.automationId === undefined || meta.promoted === true) &&
        meta.id !== input.mainId,
    )
    .sort(byNewest);
  const shown: TreeNode[] = [];
  let older = 0;
  for (const meta of roots) {
    const each = node(meta);
    const stays = each.state !== null || each.activeBelow || input.now - meta.updatedAt <= TREE_IDLE_MS;
    if (!stays || shown.length >= TREE_SESSION_CAP) {
      older += 1;
      continue;
    }
    shown.push(each);
  }
  return { main, jobs, sessions: shown, older };
}
