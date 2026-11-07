/**
 * 自动化面板的纯视图逻辑（右栏自动化面板与对话里的卡片共用）：分组 / 排序 / 状态图标 / 调度的人话 /
 * 表单与调度规则的互转 / 运行时间预览 / 模板。**不 import React**——node --test 直接加载本文件，
 * 值导入走相对路径带 .ts 后缀（`@shared` 别名只在构建期由 electron-vite 解析），文案表以参数传入。
 */
import {
  AUTOMATION_INTERVAL_MIN_MINUTES,
  AUTOMATION_RUNS_VISIBLE,
  automationWorkspaceId,
  intervalMinutes,
  isRunning,
  nextRunAfter,
  parseClockTime,
  parseSchedule,
  type Automation,
  type AutomationIntervalUnit,
  type AutomationRun,
  type AutomationSchedule,
} from "../../../../shared/automation.ts";
import type { Messages } from "../../messages-en.ts";
import type { IconName } from "../../shell/Icon.tsx";

export type AutomationMessages = Messages["automation"];

/* ---------- 状态 ---------- */

/** 行首状态图标的状态：有运行在跑就是 running（转圈），其余照任务状态 */
export type RowState = "running" | "active" | "paused" | "failed" | "completed";

export function rowStateOf(automation: Automation): RowState {
  if (isRunning(automation) && (automation.status === "active" || automation.status === "paused")) return "running";
  return automation.status;
}

/** 状态 → 图标（状态优先图标与文字，颜色是第二信号）。running 的转圈由调用方给 Icon 的 spin */
export const ROW_STATE_ICON: Record<RowState, IconName> = {
  running: "loader-circle",
  active: "calendar-clock",
  paused: "pause",
  failed: "triangle-alert",
  completed: "circle-check",
};

const STATE_RANK: Record<RowState, number> = { running: 0, active: 1, paused: 2, failed: 3, completed: 4 };

/** 排序：在跑的、在排期的在前；同档里下一次到点早的在前，没有下一次的按创建时间新→旧 */
export function sortAutomations(list: readonly Automation[]): Automation[] {
  return [...list].sort((a, b) => {
    const rank = STATE_RANK[rowStateOf(a)] - STATE_RANK[rowStateOf(b)];
    if (rank !== 0) return rank;
    if (a.nextRunAt !== null && b.nextRunAt !== null && a.nextRunAt !== b.nextRunAt) return a.nextRunAt - b.nextRunAt;
    if (a.nextRunAt !== null && b.nextRunAt === null) return -1;
    if (a.nextRunAt === null && b.nextRunAt !== null) return 1;
    return b.createdAt - a.createdAt;
  });
}

/* ---------- 分组 ---------- */

export interface AutomationGroup {
  /** 稳定 key：thisSession / workspace / ws:<id> */
  key: string;
  kind: "thisSession" | "workspace";
  /** 全部范围下各工作区一组：这里是工作区 id（null = Home）；其余组为 undefined */
  workspaceId?: string | null;
  items: Automation[];
}

export type AutomationScope = "workspace" | "all";

/**
 * 面板的分组：
 * - 本工作区：「本会话」（this_session 且绑着当前会话的）+「这个工作区」（其余，含绑在别的会话上的）；
 * - 全部：先是「本会话」，再按工作区各一组（有任务的才列）。
 * 空组不出现。
 */
export function groupAutomations(
  all: readonly Automation[],
  scope: AutomationScope,
  here: { workspaceId: string | null; sessionId: string | null },
): AutomationGroup[] {
  const mine = (automation: Automation): boolean =>
    automation.target.kind === "this_session" && here.sessionId !== null && automation.target.sessionId === here.sessionId;
  const thisSession = sortAutomations(all.filter(mine));
  const groups: AutomationGroup[] = [];
  if (thisSession.length > 0) groups.push({ key: "thisSession", kind: "thisSession", items: thisSession });
  const rest = all.filter((automation) => !mine(automation));
  if (scope === "workspace") {
    const here_ = sortAutomations(rest.filter((automation) => automationWorkspaceId(automation) === here.workspaceId));
    if (here_.length > 0) groups.push({ key: "workspace", kind: "workspace", items: here_ });
    return groups;
  }
  const order: (string | null)[] = [];
  for (const automation of rest) {
    const id = automationWorkspaceId(automation);
    if (!order.includes(id)) order.push(id);
  }
  // 当前工作区排第一，其余按首次出现的顺序
  order.sort((a, b) => (a === here.workspaceId ? -1 : b === here.workspaceId ? 1 : 0));
  for (const id of order) {
    groups.push({
      key: `ws:${id ?? ""}`,
      kind: "workspace",
      workspaceId: id,
      items: sortAutomations(rest.filter((automation) => automationWorkspaceId(automation) === id)),
    });
  }
  return groups;
}

/** 面板里能「展开看运行记录」的：有过运行记录的任务 */
export function hasRuns(automation: Automation): boolean {
  return automation.runs.length > 0;
}

/** 运行记录：默认只列最近 30 次，其余按「更早 N 次」折起（不删，只是不默认铺开） */
export function visibleRuns(
  automation: Pick<Automation, "runs">,
  showAll: boolean,
): { shown: AutomationRun[]; hidden: number } {
  if (showAll || automation.runs.length <= AUTOMATION_RUNS_VISIBLE) return { shown: automation.runs, hidden: 0 };
  return { shown: automation.runs.slice(0, AUTOMATION_RUNS_VISIBLE), hidden: automation.runs.length - AUTOMATION_RUNS_VISIBLE };
}

/** 一条工作区上的未读之类的计数用不到——自动化没有未读点；这里只数在跑的，给右栏入口的角标 */
export function runningCount(all: readonly Automation[]): number {
  return all.filter((automation) => isRunning(automation)).length;
}

/* ---------- 时间与调度的人话 ---------- */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function clock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 「今天 18:00」「明天 09:00」「11-06 周五 18:00」；跨年带年份 */
export function formatWhen(at: number, now: number, t: AutomationMessages): string {
  const date = new Date(at);
  const today = new Date(now);
  if (sameDay(date, today)) return `${t.today} ${clock(at)}`;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (sameDay(date, tomorrow)) return `${t.tomorrow} ${clock(at)}`;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const head = date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}-${day}`;
  return `${head} ${t.weekdays[date.getDay()] ?? ""} ${clock(at)}`;
}

const WORKDAYS = [1, 2, 3, 4, 5];

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((day, index) => day === b[index]);
}

/** 触发规则的人话：「每周五 18:00」「每 15 分钟」「每个工作日 09:00」 */
export function describeSchedule(schedule: AutomationSchedule, t: AutomationMessages, now: number = Date.now()): string {
  switch (schedule.kind) {
    case "once":
      return t.sched.once(formatWhen(schedule.at, now, t));
    case "interval":
      return t.sched.interval(schedule.every, schedule.unit);
    case "hourly":
      return t.sched.hourly(schedule.minute);
    case "monthly":
      return t.sched.monthly(schedule.day, schedule.time);
    case "daily": {
      if (schedule.weekdays === undefined) return t.sched.daily(schedule.time);
      if (sameDays(schedule.weekdays, WORKDAYS)) return t.sched.workdays(schedule.time);
      return t.sched.weekly(schedule.weekdays.map((day) => t.weekdays[day] ?? "").join(t.listJoin), schedule.time);
    }
  }
}

/** 行第二行：调度人话 + 状态说明 / 下次运行 */
export function subtitleOf(automation: Automation, now: number, t: AutomationMessages): string {
  const schedule = describeSchedule(automation.schedule, t, now);
  switch (rowStateOf(automation)) {
    case "paused":
      return `${schedule} · ${t.state.paused}`;
    case "failed":
      return `${schedule} · ${t.state.failed}`;
    case "completed":
      return `${schedule} · ${automation.endReason === undefined ? t.state.completed : t.endReason[automation.endReason]}`;
    case "running":
    case "active": {
      if (automation.pendingDelivery !== undefined) return `${schedule} · ${t.waitingIdle}`;
      if (automation.nextRunAt === null) return schedule;
      return `${schedule} · ${t.next(formatWhen(automation.nextRunAt, now, t))}`;
    }
  }
}

/** 行右上角的次数：有上限写 3/12 次，没有写「已运行 6 次」；一次都没跑过写空串 */
export function countLabel(automation: Automation, t: AutomationMessages): string {
  if (automation.maxRuns !== undefined) return t.countOf(automation.runCount, automation.maxRuns);
  return automation.runCount === 0 ? "" : t.countPlain(automation.runCount);
}

/** 这一行要单独提醒的一句话（失败原因 / 最近一次失败 / 会话是 manual 档会卡在审批）；没有返回 null */
export function noteOf(
  automation: Automation,
  t: AutomationMessages,
  boundSession: { mode: string } | null,
): { text: string; tone: "danger" | "warn" } | null {
  if (automation.status === "failed") {
    return { text: t.failedBecause(automation.failureReason ?? ""), tone: "danger" };
  }
  const last = automation.runs.find((run) => run.status !== "skipped" && run.status !== "running");
  if (automation.status === "active" && last?.status === "error" && last.error !== undefined) {
    return { text: t.lastFailed(last.error), tone: "danger" };
  }
  if (automation.target.kind === "this_session" && boundSession?.mode === "manual" && automation.status === "active") {
    return { text: t.manualWarn, tone: "warn" };
  }
  return null;
}

/* ---------- 运行记录行 ---------- */

export interface RunLine {
  icon: IconName;
  tone: "ok" | "bad" | "wait" | "run" | "mute";
  /** 一句话：结果摘录 / 失败原因 / 跳过原因 / 补跑说明 */
  text: string;
}

export function runLine(run: AutomationRun, t: AutomationMessages): RunLine {
  if (run.status === "running") return { icon: "loader-circle", tone: "run", text: t.runs.running };
  if (run.status === "skipped") {
    const reason = run.skipReason === "dailyCap" ? t.runs.skippedCap : t.runs.skippedOverlap;
    return { icon: "circle-dashed", tone: "mute", text: run.repeat !== undefined ? `${reason} ×${run.repeat}` : reason };
  }
  const merged = run.merged !== undefined ? ` · ${t.runs.merged(run.merged)}` : "";
  if (run.status === "error") return { icon: "triangle-alert", tone: "bad", text: `${t.runs.failed(run.error ?? "")}${merged}` };
  const body = run.resultExcerpt !== undefined && run.resultExcerpt !== "" ? run.resultExcerpt : t.runs.done;
  if (run.trigger === "caughtUp") return { icon: "history", tone: "wait", text: `${t.runs.catchUp} · ${body}${merged}` };
  return { icon: "circle-check", tone: "ok", text: `${body}${merged}` };
}

/** 运行记录的时间列：「10-24 周五 18:00」 */
export function runWhen(run: AutomationRun, now: number, t: AutomationMessages): string {
  const date = new Date(run.runAt);
  if (sameDay(date, new Date(now))) return `${t.today} ${clock(run.runAt)}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${t.weekdays[date.getDay()] ?? ""} ${clock(run.runAt)}`;
}

/** token 数的紧凑写法：212k / 1.2M；不知道返回空串 */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/* ---------- 表单 ---------- */

export const SCHEDULE_PRESETS = ["hourly", "daily", "weekdays", "weekly", "monthly", "once", "custom"] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

/** 调度表单的状态：每个预设用到的字段都留着，切预设不丢另一个预设里填过的值 */
export interface ScheduleForm {
  preset: SchedulePreset;
  /** hourly：第几分 */
  minute: number;
  /** daily / weekdays / weekly / monthly / once：HH:MM */
  time: string;
  /** weekly：选中的星期（0 = 周日） */
  weekdays: number[];
  /** monthly：几号 */
  monthDay: number;
  /** once：YYYY-MM-DD */
  date: string;
  /** custom：每 N 个 unit */
  every: number;
  unit: AutomationIntervalUnit;
}

export function dateInputValue(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 表单的默认值：每天 09:00；once 默认明天（`now` 注入便于测试） */
export function defaultScheduleForm(now: number): ScheduleForm {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    preset: "daily",
    minute: 0,
    time: "09:00",
    weekdays: [new Date(now).getDay()],
    monthDay: 1,
    date: dateInputValue(tomorrow.getTime()),
    every: 30,
    unit: "minute",
  };
}

/** 已有的调度规则 → 表单（编辑时回填） */
export function formFromSchedule(schedule: AutomationSchedule, now: number): ScheduleForm {
  const base = defaultScheduleForm(now);
  switch (schedule.kind) {
    case "hourly":
      return { ...base, preset: "hourly", minute: schedule.minute };
    case "monthly":
      return { ...base, preset: "monthly", monthDay: schedule.day, time: schedule.time };
    case "interval":
      return { ...base, preset: "custom", every: schedule.every, unit: schedule.unit };
    case "once":
      return { ...base, preset: "once", date: dateInputValue(schedule.at), time: clock(schedule.at) };
    case "daily": {
      if (schedule.weekdays === undefined) return { ...base, preset: "daily", time: schedule.time };
      if (sameDays(schedule.weekdays, WORKDAYS)) return { ...base, preset: "weekdays", time: schedule.time };
      return { ...base, preset: "weekly", time: schedule.time, weekdays: schedule.weekdays };
    }
  }
}

/** 表单 → 调度规则；填得不对返回说明用的 error key（面板用 t.errors[key] 显示） */
export function scheduleFromForm(
  form: ScheduleForm,
  now: number,
): { ok: true; schedule: AutomationSchedule } | { ok: false; error: "time" | "date" | "days" | "interval" | "minute" | "monthDay" | "past" } {
  const timeOk = parseClockTime(form.time) !== null;
  switch (form.preset) {
    case "hourly":
      return Number.isInteger(form.minute) && form.minute >= 0 && form.minute <= 59
        ? { ok: true, schedule: { kind: "hourly", minute: form.minute } }
        : { ok: false, error: "minute" };
    case "daily":
      return timeOk ? { ok: true, schedule: { kind: "daily", time: form.time } } : { ok: false, error: "time" };
    case "weekdays":
      return timeOk ? { ok: true, schedule: { kind: "daily", time: form.time, weekdays: [...WORKDAYS] } } : { ok: false, error: "time" };
    case "weekly": {
      if (!timeOk) return { ok: false, error: "time" };
      if (form.weekdays.length === 0) return { ok: false, error: "days" };
      const parsed = parseSchedule({ kind: "daily", time: form.time, weekdays: form.weekdays }, now);
      return parsed.ok ? parsed : { ok: false, error: "days" };
    }
    case "monthly":
      if (!timeOk) return { ok: false, error: "time" };
      return Number.isInteger(form.monthDay) && form.monthDay >= 1 && form.monthDay <= 31
        ? { ok: true, schedule: { kind: "monthly", day: form.monthDay, time: form.time } }
        : { ok: false, error: "monthDay" };
    case "custom": {
      const parsed = parseSchedule({ kind: "interval", unit: form.unit, every: form.every }, now);
      return parsed.ok ? parsed : { ok: false, error: "interval" };
    }
    case "once": {
      if (!timeOk) return { ok: false, error: "time" };
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(form.date);
      if (match === null) return { ok: false, error: "date" };
      const clockParts = parseClockTime(form.time);
      const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), clockParts?.[0] ?? 0, clockParts?.[1] ?? 0).getTime();
      if (!Number.isFinite(at)) return { ok: false, error: "date" };
      return at > now ? { ok: true, schedule: { kind: "once", at } } : { ok: false, error: "past" };
    }
  }
}

/** 运行时间预览：接下来 N 次（once 只有一次；排不出就空）。`until` 之后的不算 */
export function previewTimes(schedule: AutomationSchedule, now: number, count: number, until?: number): number[] {
  const out: number[] = [];
  let from = now;
  for (let i = 0; i < count; i += 1) {
    const next = schedule.kind === "once" ? (schedule.at > now && i === 0 ? schedule.at : null) : nextRunAfter(schedule, from);
    if (next === null || (until !== undefined && next > until)) break;
    out.push(next);
    from = next;
  }
  return out;
}

/** 总间隔不足 5 分钟时给界面一句提示用（表单的 custom 行） */
export function intervalTooShort(form: Pick<ScheduleForm, "every" | "unit">): boolean {
  return intervalMinutes(form) < AUTOMATION_INTERVAL_MIN_MINUTES;
}

export type EndMode = "never" | "count" | "date";

export interface EndForm {
  mode: EndMode;
  count: number;
  /** YYYY-MM-DD；当天结束（日末） */
  date: string;
}

export function endFormFrom(automation: Pick<Automation, "maxRuns" | "until"> | null, now: number): EndForm {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 7);
  const base: EndForm = { mode: "never", count: 12, date: dateInputValue(tomorrow.getTime()) };
  if (automation?.maxRuns !== undefined) return { ...base, mode: "count", count: automation.maxRuns };
  if (automation?.until !== undefined) return { ...base, mode: "date", date: dateInputValue(automation.until) };
  return base;
}

/** 结束表单 → 载荷里的 maxRuns / until（null = 清掉）；日期取当天日末 */
export function endFromForm(
  form: EndForm,
  now: number,
): { ok: true; maxRuns: number | null; until: number | null } | { ok: false; error: "count" | "date" | "past" } {
  if (form.mode === "never") return { ok: true, maxRuns: null, until: null };
  if (form.mode === "count") {
    return Number.isInteger(form.count) && form.count >= 1 ? { ok: true, maxRuns: form.count, until: null } : { ok: false, error: "count" };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(form.date);
  if (match === null) return { ok: false, error: "date" };
  const until = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999).getTime();
  if (!Number.isFinite(until)) return { ok: false, error: "date" };
  return until > now ? { ok: true, maxRuns: null, until } : { ok: false, error: "past" };
}

/* ---------- 模型选项 ---------- */

/** 模型下拉的值：provider id 与型号 id 用不会出现在 id 里的分隔符拼起来；空串 = 默认（按子会话型号解析） */
const MODEL_SEPARATOR = "\u001f";

export function modelOptionValue(providerId: string, modelId: string): string {
  return `${providerId}${MODEL_SEPARATOR}${modelId}`;
}

export function parseModelOption(value: string): { providerId: string; modelId: string } | null {
  const index = value.indexOf(MODEL_SEPARATOR);
  if (index <= 0) return null;
  return { providerId: value.slice(0, index), modelId: value.slice(index + 1) };
}

/* ---------- 模板（空态） ---------- */

export interface AutomationTemplate {
  id: "paper" | "changes" | "watch";
  icon: IconName;
  /** 预填进表单的调度（now 无关，纯规则） */
  schedule: AutomationSchedule;
  maxRuns?: number;
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  { id: "paper", icon: "book-open", schedule: { kind: "daily", time: "09:00", weekdays: [1] } },
  { id: "changes", icon: "git-branch", schedule: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } },
  { id: "watch", icon: "scroll-text", schedule: { kind: "interval", unit: "minute", every: 15 }, maxRuns: 12 },
];
