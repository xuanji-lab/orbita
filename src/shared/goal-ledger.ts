/**
 * 目标与计划的改动账（2026-10-30）：目标和计划的每一次改动，都记「从什么变成什么、为什么、来源」。
 *
 * 用户 14:29 原话：「现在就是看得到更新，但是看不到从什么更新到了什么……你有记录这个变化的过程和理由，
 * 反而对 agent 来说会比较有帮助……你如果有记录、有呈现出来，用户不需要看上下文就可以回忆起来。」
 *
 * **账不另存，从转录里推**：输入是归一化的事件流（用户消息、update_goal / update_plan 的调用），
 * 界面（renderer，来自 TranscriptRecord）与 agent 进程（压缩时，来自 pi 本子的条目）各写一个很薄的
 * 适配器把自己的记录变成事件，账本本身只有这一份——回退、分支、重开会话、压缩都跟着转录走，不会有
 * 「账还在、对话已回退」的两份真相。迁 pi-durable 后目标变一份 defineDoc，账仍从调用推。
 *
 * 来源（谁触发的改动）：
 * - 目标：update_goal 的 by（user / self）；没写按 user——目标主要来自用户的话；
 * - 计划：**这一轮用户消息之后的第一次 update_plan** 算这条用户消息触发的（它是在回应这句话），之后同一轮里
 *   再改是 agent 做事时自己发现的。这是按时序的推断，不是模型自述（给 update_plan 再加一个字段，负担落在
 *   本来就常漏写 why 的弱模型身上）。
 *
 * 纯模块：不 import electron / React，可被 node --test 直接加载。
 */
import { GOAL_TOOL_NAME, parseGoalCallLoose } from "./goal.ts";
import { parsePlanItemsLoose, parsePlanNotes, PLAN_TOOL_NAME } from "./plan.ts";
import { diffPlans, type PlanChange } from "./plan-diff.ts";

/** 归一化的事件：账本只认这两种 */
export type LedgerEvent =
  | { kind: "user"; id: string; at: number; text: string }
  | {
      kind: "call";
      /** toolCallId */
      id: string;
      at: number;
      tool: string;
      input: unknown;
      /** 这次调用被拒 / 报错（没生效，不入账）；还在跑的不算失败 */
      failed: boolean;
    };

/** 改动的来源：用户的某条消息（时间 + 头一行，可点回去），或 agent 自己发现 */
export type LedgerSource = { kind: "user"; id: string; at: number; head: string } | { kind: "self" };

export interface GoalEntry {
  kind: "goal";
  /** update_goal 调用的 toolCallId */
  id: string;
  at: number;
  /** 改之前的目标；第一次定目标 = null */
  from: string | null;
  to: string;
  why: string | null;
  source: LedgerSource;
}

export interface PlanEntry {
  kind: "plan";
  /** update_plan 调用的 toolCallId */
  id: string;
  at: number;
  /** 结构改动（加 / 去 / 改说法 / 挪 / 拆 / 合）；换了一张新计划时为空 */
  changes: PlanChange[];
  /** 换了一张新计划（与上一张一步都对不上）：新计划的步骤文字；否则 null */
  replaced: string[] | null;
  why: string | null;
  source: LedgerSource;
}

export type LedgerEntry = GoalEntry | PlanEntry;

export interface GoalLedger {
  /** 当前目标（最后一次有效的 update_goal）；没定过 = null */
  goal: { text: string; at: number } | null;
  /** 全部改动，旧 → 新（第一次写下计划不是改动，不入账） */
  entries: LedgerEntry[];
  /** 这个会话里做完的 todo（跨计划累计，去重）与当前计划里还没做完的 */
  todos: { done: string[]; open: string[] };
}

/** 用户消息的头一行：去空白，超长截断 */
export function headLine(text: string, max = 60): string {
  const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export function buildGoalLedger(events: readonly LedgerEvent[]): GoalLedger {
  const entries: LedgerEntry[] = [];
  // 用对象字段承载可变状态：循环里 continue 多，裸 let 会让 TS 把初值 null 一路收窄下去
  const current: { goal: GoalLedger["goal"] } = { goal: null };
  type UserEvent = Extract<LedgerEvent, { kind: "user" }>;
  const last: { user: UserEvent | null } = { user: null };
  let planCallsSinceUser = 0;
  let prevItems: ReturnType<typeof parsePlanItemsLoose> | null = null;
  const done: string[] = [];
  const noteDone = (items: readonly { text: string; status: string }[]): void => {
    for (const item of items) if (item.status === "done" && !done.includes(item.text)) done.push(item.text);
  };

  for (const event of events) {
    if (event.kind === "user") {
      last.user = event;
      planCallsSinceUser = 0;
      continue;
    }
    if (event.failed) continue;
    const asked = last.user;
    const userSource: LedgerSource =
      asked === null ? { kind: "self" } : { kind: "user", id: asked.id, at: asked.at, head: headLine(asked.text) };

    if (event.tool === GOAL_TOOL_NAME) {
      const call = parseGoalCallLoose(event.input);
      if (call === null || call.goal === current.goal?.text) continue;
      entries.push({
        kind: "goal",
        id: event.id,
        at: event.at,
        from: current.goal?.text ?? null,
        to: call.goal,
        why: call.why,
        source: call.by === "self" ? { kind: "self" } : userSource,
      });
      current.goal = { text: call.goal, at: event.at };
      continue;
    }

    if (event.tool === PLAN_TOOL_NAME) {
      const items = parsePlanItemsLoose(event.input);
      if (items.length === 0) continue;
      const diff = diffPlans(prevItems, items);
      const first = planCallsSinceUser === 0;
      planCallsSinceUser += 1;
      noteDone(items);
      const replaced = prevItems !== null && diff.fresh;
      if (prevItems !== null && (replaced || diff.changes.length > 0)) {
        entries.push({
          kind: "plan",
          id: event.id,
          at: event.at,
          changes: replaced ? [] : diff.changes,
          replaced: replaced ? items.map((item) => item.text) : null,
          why: parsePlanNotes(event.input).why,
          source: first ? userSource : { kind: "self" },
        });
      }
      prevItems = items;
    }
  }

  const open = (prevItems ?? []).filter((item) => item.status !== "done" && !done.includes(item.text)).map((item) => item.text);
  return { goal: current.goal, entries, todos: { done, open } };
}

// —— 给模型看的文字（英文；用户的话原样引用）——

const pad = (n: number): string => String(n).padStart(2, "0");

/** 本地时间 YYYY-MM-DD HH:MM：同一份账同一时区下逐字节稳定（压缩后的摘要附段每轮重放，不能抖） */
export function ledgerTime(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 改动要点里一段文字最长多少字符（目标自己写得长时只留开头；当前目标另行全文给出） */
export const LEDGER_TEXT_MAX = 120;
/** 摘取两段文字不同处时，不同处前后各留多少字符的上下文 */
const SNIPPET_CONTEXT = 24;

/**
 * 「从 A 改成 B」里把两段长文字各自缩成一小段：只留**不同的地方**和它前后的上下文，公共的开头 / 结尾用省略号。
 * 只截开头会出事——实测里目标是在末尾追加了一句「最后还要有命令行入口 cli.js…」，前 120 字完全相同，
 * 截出来「从什么变成什么」两边一模一样（2026-10-30 Kimi 实跑）。
 * 短到不用缩（两段都不超过 max）原样返回；缩完仍超过 max 的再从尾部截断。
 */
/** 一段文字只留开头 max 个字符（第一次定目标那条用：要看的是它怎么开头的） */
export function headSnippet(text: string, max = LEDGER_TEXT_MAX): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export function snippetPair(from: string, to: string, max = LEDGER_TEXT_MAX): [string, string] {
  const a = [...from];
  const b = [...to];
  if (a.length <= max && b.length <= max) return [from, to];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) suffix++;
  const start = Math.max(0, prefix - SNIPPET_CONTEXT);
  const keepTail = Math.min(suffix, SNIPPET_CONTEXT);
  const cut = (chars: string[]): string => {
    const end = chars.length - suffix + keepTail;
    let out = chars.slice(start, end).join("");
    if (start > 0) out = `…${out}`;
    if (end < chars.length) out = `${out}…`;
    const o = [...out];
    return o.length > max ? `${o.slice(0, max - 1).join("")}…` : out;
  };
  return [cut(a), cut(b)];
}
const q = (text: string, max = 160): string => `"${text.length > max ? `${text.slice(0, max - 1)}…` : text}"`;

function changeEn(change: PlanChange): string {
  switch (change.kind) {
    case "added":
      return `added ${q(change.text)}`;
    case "removed":
      return `dropped ${q(change.text)}`;
    case "reworded":
      return `reworded ${q(change.from)} → ${q(change.to)}`;
    case "moved":
      return change.before === null ? `moved ${q(change.text)} to the end` : `moved ${q(change.text)} before ${q(change.before)}`;
    case "split":
      return `split ${q(change.from)} into ${change.into.map((text) => q(text)).join(", ")}`;
    case "merged":
      return `merged ${change.from.map((text) => q(text)).join(", ")} into ${q(change.into)}`;
  }
}

function sourceEn(source: LedgerSource): string {
  return source.kind === "user" ? `user message ${ledgerTime(source.at)} ${q(source.head, 80)}` : "the agent's own finding";
}

/** 每段最多留几条：账是「要点」，不是流水账；更早的只在转录里 */
export const LEDGER_MODEL_MAX_GOAL_ENTRIES = 8;
export const LEDGER_MODEL_MAX_PLAN_ENTRIES = 10;
const MAX_TODOS = 20;

/**
 * 账本 → 压缩后附在摘要后面的一段固定文字。账是空的（没定过目标、没改过计划）= null，不附。
 * 目标原样、改动账要点原样，不经模型改写。
 */
export function renderLedgerForModel(ledger: GoalLedger): string | null {
  const goalEntries = ledger.entries.filter((entry): entry is GoalEntry => entry.kind === "goal");
  const planEntries = ledger.entries.filter((entry): entry is PlanEntry => entry.kind === "plan");
  if (ledger.goal === null && planEntries.length === 0 && ledger.todos.done.length === 0 && ledger.todos.open.length === 0) {
    return null;
  }
  const lines: string[] = [
    "---",
    "Session goal ledger (kept verbatim by Orbita; it is not part of the summary above and was not rewritten):",
  ];
  if (ledger.goal !== null) lines.push(`Current goal: ${q(ledger.goal.text, 400)}`);
  if (goalEntries.length > 0) {
    lines.push("Goal changes (oldest first):");
    for (const entry of goalEntries.slice(-LEDGER_MODEL_MAX_GOAL_ENTRIES)) {
      const why = entry.why === null ? "" : ` because ${entry.why}`;
      const [from, to] = entry.from === null ? [null, headSnippet(entry.to)] : snippetPair(entry.from, entry.to);
      const change = from === null ? `set ${q(to, 400)}` : `${q(from, 400)} → ${q(to, 400)}`;
      lines.push(`- ${ledgerTime(entry.at)} ${change}${why} (${sourceEn(entry.source)})`);
    }
  }
  if (planEntries.length > 0) {
    lines.push("Plan changes (oldest first):");
    for (const entry of planEntries.slice(-LEDGER_MODEL_MAX_PLAN_ENTRIES)) {
      const what =
        entry.replaced !== null
          ? `replaced the plan with a new one: ${entry.replaced.map((text) => q(text, 80)).join(", ")}`
          : entry.changes.map(changeEn).join("; ");
      const why = entry.why === null ? "" : ` because ${entry.why}`;
      lines.push(`- ${ledgerTime(entry.at)} ${what}${why} (${sourceEn(entry.source)})`);
    }
  }
  if (ledger.todos.done.length > 0) lines.push(`Todos done: ${ledger.todos.done.slice(-MAX_TODOS).map((text) => q(text, 100)).join("; ")}`);
  if (ledger.todos.open.length > 0) lines.push(`Todos still open: ${ledger.todos.open.slice(0, MAX_TODOS).map((text) => q(text, 100)).join("; ")}`);
  return lines.join("\n");
}
