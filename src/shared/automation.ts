/**
 * 自动化（实验功能 automation）的契约真源 —— IPC 四层的第 1 层。
 *
 * 自动化 = 一条**定时任务**：到点把一段指令交给 agent 去跑。两种去处（ZCode 的 targetTaskId 思路）：
 * - `new_session`：每次在该工作区**新开一条会话**跑（会话 meta 记 `automationId`，不进左侧栏，
 *   只从右栏自动化面板里这条任务下面进；想继续聊可「转成普通会话」）；
 * - `this_session`：在对话里建的默认绑定**创建它的那条会话**，到点把指令**送回这条会话**
 *   （会话空闲就开一轮；在跑就等这一轮结束再送，等待期间再到点只合并成一次）。
 *
 * **自动化是工作区里那个主 agent 的工具，不是某个会话上的工具卡**（2026-10-26 用户裁决）：
 * 智能体档案还没做，v1 用「工作区」代表「这个工作区的主 agent」——`workspaceId` 为 null 即 Home。
 * 用户 2026-10-31：agent 在对话里建的**直接生效**（不再有待启用）；先做自动化本身，
 * 多少功能要集成进看板之后再看。
 *
 * 本文件只放**不依赖 electron / node 的纯定义**：类型、护栏常量、调度的纯函数、逐字段解析。
 * 主进程（存盘 / 调度）与 renderer（表单校验 / 面板）共用同一份，不各写一套。
 */
import type { PermissionMode } from "./permission.ts";
import { isThinkingLevel, type ThinkingLevel } from "./thinking.ts";

/* ---------- 护栏常量 ---------- */

/** 重复间隔的下限（分钟）。更密的「定期」不是例行，是循环——不给。 */
export const AUTOMATION_INTERVAL_MIN_MINUTES = 5;
/** 重复间隔的上限（分钟）：一年。再长换 monthly / once。 */
export const AUTOMATION_INTERVAL_MAX_MINUTES = 60 * 24 * 365;
/** 每条自动化滚动 24 小时内最多真正跑的次数（花钱的次数；skipped 不计） */
export const AUTOMATION_MAX_RUNS_PER_DAY = 24;
/** 一条自动化的 runs 只留最近这么多条（面板默认只列最近 30 次，更早的点开看） */
export const AUTOMATION_RUNS_KEPT = 100;
/** 面板里一条任务默认列出的运行次数 */
export const AUTOMATION_RUNS_VISIBLE = 30;
/** agent 建的必须有终点：没给 maxRuns / until 时落这个值 */
export const AUTOMATION_AGENT_DEFAULT_MAX_RUNS = 12;
/** agent 能给的 maxRuns 上限（再多请用户在面板里自己建）。用户亲手建的不受此限 */
export const AUTOMATION_AGENT_MAX_RUNS_CAP = 100;
/** 用户手建的 maxRuns 上限（防手滑填天文数字；24 小时 24 次的护栏另在调度里） */
export const AUTOMATION_USER_MAX_RUNS_CAP = 10_000;
/** 一条会话上同时「活跃」的任务数上限（this_session 绑定的那条会话算） */
export const AUTOMATION_MAX_ACTIVE_PER_SESSION = 5;
/** 全部自动化条数上限（所有状态都计入，同 ZCode 的 AUTOMATION_CREATE_LIMIT；已完成的要在面板里删掉腾位） */
export const AUTOMATION_MAX_TOTAL = 20;
/** 连续失败这么多次进入失败态（可「重新启动」） */
export const AUTOMATION_MAX_CONSECUTIVE_FAILURES = 3;
/** 标题长度上限：会话标题「<标题> · <日期时间>」要在 deriveSessionTitle 的 60 字内放得下 */
export const AUTOMATION_TITLE_MAX = 40;
/** 指令长度上限（字符） */
export const AUTOMATION_PROMPT_MAX = 8000;
/** 最近一次成功回答带进下一次提示词的上限（字符，约 2KB） */
export const AUTOMATION_LAST_RESULT_MAX = 2000;
/** 面板里结果摘录的长度（字符，约 300 字） */
export const AUTOMATION_EXCERPT_MAX = 300;

/* ---------- 触发规则 ---------- */

/** 「每 N 个…」的单位 */
export const AUTOMATION_INTERVAL_UNITS = ["minute", "hour", "day"] as const;
export type AutomationIntervalUnit = (typeof AUTOMATION_INTERVAL_UNITS)[number];

const UNIT_MINUTES: Record<AutomationIntervalUnit, number> = { minute: 1, hour: 60, day: 60 * 24 };

/**
 * 触发规则。表单里的「每小时 / 每天 / 每工作日 / 每周 / 每月 / 一次性 / 自定义」都落在这五种上：
 * - `once`：某一时刻（epoch ms）；
 * - `interval`：自定义，每 N 分钟 / 小时 / 天，**从上一次触发起算**（总间隔 ≥ 5 分钟）；
 * - `hourly`：每小时的第 minute 分；
 * - `daily`：每天本机时间 HH:MM，可限定星期（0 = 周日 … 6 = 周六）——每天 / 每工作日（1–5）/ 每周（选几天）；
 * - `monthly`：每月 day 日 HH:MM（31 日在短月落到月末）。
 */
export type AutomationSchedule =
  | { kind: "once"; at: number }
  | { kind: "interval"; unit: AutomationIntervalUnit; every: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string; weekdays?: number[] }
  | { kind: "monthly"; day: number; time: string };

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" → [h, m]；格式不对返回 null */
export function parseClockTime(time: string): [number, number] | null {
  const match = TIME_PATTERN.exec(time);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
}

/** weekdays 规整：去重、排序、越界丢弃；空或七天全选等价于「每天」（返回 undefined） */
export function normalizeWeekdays(raw: readonly unknown[] | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const days = [
    ...new Set(raw.filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6)),
  ].sort((a, b) => a - b);
  return days.length === 0 || days.length === 7 ? undefined : days;
}

/** 一个 interval 规则折成分钟 */
export function intervalMinutes(schedule: { unit: AutomationIntervalUnit; every: number }): number {
  return schedule.every * UNIT_MINUTES[schedule.unit];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 解析并校验一条触发规则（renderer 表单、IPC 入口、agent 工具共用）。
 * 返回规整后的规则，或一句说明哪里不对的话。`now` 只用于 once 的「必须在未来」。
 */
export function parseSchedule(raw: unknown, now: number): { ok: true; schedule: AutomationSchedule } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "schedule must be an object." };
  const value = raw as Record<string, unknown>;
  const clock = (field: string): Parsed<string> => {
    const time = value[field];
    if (typeof time !== "string" || parseClockTime(time) === null) {
      return { ok: false, error: `schedule.${field} must look like "09:00" (24-hour, local time).` };
    }
    return { ok: true, value: time };
  };
  switch (value["kind"]) {
    case "once": {
      const at = value["at"];
      if (typeof at !== "number" || !Number.isFinite(at)) return { ok: false, error: "schedule.at must be a timestamp in ms." };
      if (at <= now) return { ok: false, error: "schedule.at is already in the past." };
      return { ok: true, schedule: { kind: "once", at: Math.round(at) } };
    }
    case "interval": {
      const unit = value["unit"];
      const every = value["every"];
      if (!(AUTOMATION_INTERVAL_UNITS as readonly unknown[]).includes(unit)) {
        return { ok: false, error: 'schedule.unit must be "minute", "hour" or "day".' };
      }
      if (typeof every !== "number" || !Number.isInteger(every) || every < 1) {
        return { ok: false, error: "schedule.every must be a positive integer." };
      }
      const schedule = { kind: "interval", unit: unit as AutomationIntervalUnit, every } as const;
      const minutes = intervalMinutes(schedule);
      if (minutes < AUTOMATION_INTERVAL_MIN_MINUTES) {
        return { ok: false, error: `The interval must be at least ${AUTOMATION_INTERVAL_MIN_MINUTES} minutes.` };
      }
      if (minutes > AUTOMATION_INTERVAL_MAX_MINUTES) {
        return { ok: false, error: "The interval must be at most one year; use monthly or once for longer cycles." };
      }
      return { ok: true, schedule };
    }
    case "hourly": {
      const minute = value["minute"];
      if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return { ok: false, error: "schedule.minute must be an integer 0-59." };
      }
      return { ok: true, schedule: { kind: "hourly", minute } };
    }
    case "daily": {
      const time = clock("time");
      if (!time.ok) return time;
      const weekdaysRaw = value["weekdays"];
      if (weekdaysRaw !== undefined && !Array.isArray(weekdaysRaw)) {
        return { ok: false, error: "schedule.weekdays must be an array of 0-6 (0 = Sunday)." };
      }
      if (Array.isArray(weekdaysRaw) && weekdaysRaw.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) {
        return { ok: false, error: "schedule.weekdays must only contain 0-6 (0 = Sunday)." };
      }
      const weekdays = normalizeWeekdays(Array.isArray(weekdaysRaw) ? weekdaysRaw : undefined);
      return { ok: true, schedule: { kind: "daily", time: time.value, ...(weekdays === undefined ? {} : { weekdays }) } };
    }
    case "monthly": {
      const day = value["day"];
      if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
        return { ok: false, error: "schedule.day must be an integer 1-31." };
      }
      const time = clock("time");
      if (!time.ok) return time;
      return { ok: true, schedule: { kind: "monthly", day, time: time.value } };
    }
    default:
      return { ok: false, error: 'schedule.kind must be "once", "interval", "hourly", "daily" or "monthly".' };
  }
}

/**
 * `from` 之后（严格大于）的下一次触发时间；没有下一次返回 null（once 已过）。
 *
 * 纯函数、不读时钟。daily / monthly / hourly 按**本机时区**的墙上时间推。夏令时不特殊处理：
 * 春季被跳过的钟点 JS 会顺延到下一个有效时刻，秋季重复的钟点因为要求严格晚于 from 不会连触两次；
 * 逐日 / 逐月搜索有上限，找不到（只有规则非法才会）返回 null，不会死循环。
 */
export function nextRunAfter(schedule: AutomationSchedule, from: number): number | null {
  if (!Number.isFinite(from)) return null;
  switch (schedule.kind) {
    case "once":
      return schedule.at > from ? schedule.at : null;
    case "interval":
      return from + intervalMinutes(schedule) * 60_000;
    case "hourly": {
      const candidate = new Date(from);
      candidate.setMinutes(schedule.minute, 0, 0);
      if (candidate.getTime() <= from) candidate.setHours(candidate.getHours() + 1);
      return candidate.getTime();
    }
    case "daily": {
      const clock = parseClockTime(schedule.time);
      if (clock === null) return null;
      const allowed = schedule.weekdays === undefined ? null : new Set(schedule.weekdays);
      for (let offset = 0; offset <= 8; offset += 1) {
        const candidate = new Date(from);
        candidate.setDate(candidate.getDate() + offset);
        candidate.setHours(clock[0], clock[1], 0, 0);
        const at = candidate.getTime();
        if (at > from && (allowed === null || allowed.has(candidate.getDay()))) return at;
      }
      return null;
    }
    case "monthly": {
      const clock = parseClockTime(schedule.time);
      if (clock === null) return null;
      const origin = new Date(from);
      for (let offset = 0; offset <= 13; offset += 1) {
        const year = origin.getFullYear();
        const month = origin.getMonth() + offset;
        // 该月最后一天：下个月的第 0 天
        const lastDay = new Date(year, month + 1, 0).getDate();
        const candidate = new Date(year, month, Math.min(schedule.day, lastDay), clock[0], clock[1], 0, 0);
        if (candidate.getTime() > from) return candidate.getTime();
      }
      return null;
    }
  }
}

/** 触发规则的英文一句话（agent 工具回执与日志用；界面文案走 messages-*） */
export function describeScheduleEn(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case "once":
      return `once at ${new Date(schedule.at).toISOString()}`;
    case "interval":
      return `every ${schedule.every} ${schedule.unit}${schedule.every === 1 ? "" : "s"}`;
    case "hourly":
      return `hourly at minute ${schedule.minute}`;
    case "daily":
      return `daily at ${schedule.time} local time, ${
        schedule.weekdays === undefined ? "every day" : `on weekdays [${schedule.weekdays.join(",")}] (0 = Sunday)`
      }`;
    case "monthly":
      return `monthly on day ${schedule.day} at ${schedule.time} local time`;
  }
}

/* ---------- 对象 ---------- */

export const AUTOMATION_STATUSES = ["active", "paused", "failed", "completed"] as const;
/**
 * 状态：
 * - `active` 在排期（有没有正在跑的运行另看 runs 里有没有 running）；
 * - `paused` 用户暂停；
 * - `failed` 连续失败 3 次（或这条任务绑定的东西坏了）自动停下，可「重新启动」；
 * - `completed` 终点到了（跑满次数 / 过了结束日期 / 一次性跑完）或被取消 / 绑定的会话被删。
 */
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/** completed 的原因（面板上说清「为什么停了」） */
export type AutomationEndReason = "finished" | "expired" | "cancelled" | "sessionDeleted";

/**
 * 无人值守的权限档：只有 plan（只读）和 skip（全放行）。**没有 manual**——审批弹窗永远没人点，
 * 会话会一直停在审批上。this_session 的任务不看这一档，跟它绑定的会话自己的档。
 */
export const AUTOMATION_MODES = ["plan", "skip"] as const satisfies readonly PermissionMode[];
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export function isAutomationMode(value: unknown): value is AutomationMode {
  return (AUTOMATION_MODES as readonly unknown[]).includes(value);
}

/** 去处：每次新开一条会话，或投回创建它的那条会话 */
export type AutomationTarget =
  | { kind: "new_session"; workspaceId: string | null }
  | { kind: "this_session"; sessionId: string; workspaceId: string | null };

/** 谁建的。agent 建的记来源会话——面板上能跳回去看当时为什么建，也是「投回原会话」的候选。 */
export type AutomationCreator = { kind: "user" } | { kind: "agent"; sessionId: string };

/**
 * 一次运行是怎么被触发的：`schedule` 到点；`manual` 用户点了「立即运行」；
 * `caughtUp` 应用没开 / 电脑睡眠错过了排期，醒来**只补一次**。
 */
export type AutomationRunTrigger = "schedule" | "manual" | "caughtUp";

/** 运行结果：running 在跑；success / error 跑完了；skipped 没跑（上次还在跑 / 24 小时上限） */
export type AutomationRunStatus = "running" | "success" | "error" | "skipped";

export type AutomationSkipReason = "overlap" | "dailyCap";

export interface AutomationRun {
  id: string;
  /** 触发 / 送达时刻（epoch ms） */
  runAt: number;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  /**
   * 这次运行跑在哪条会话：new_session 是它新开的那条；this_session 是被叫醒的那条（同一条会话，
   * 每次都一样）；skipped 没有。
   */
  sessionId: string | null;
  durationMs: number | null;
  /** 这次运行的 token 总数（new_session：会话 stats 的 total；this_session 不单独量，为 null） */
  tokens: number | null;
  error?: string;
  skipReason?: AutomationSkipReason;
  /** skipped：同一原因连续跳过 N 次合并成一条（防止「上次还在跑」刷满历史） */
  repeat?: number;
  /** this_session：会话还在忙时又到点的 N 次，合并成这一次送达 */
  merged?: number;
  /** 最终回答的前 ~300 字 */
  resultExcerpt?: string;
}

export interface Automation {
  id: string;
  title: string;
  /** 每次运行交给 agent 的指令 */
  prompt: string;
  schedule: AutomationSchedule;
  target: AutomationTarget;
  /** new_session 才用：缺席 = 不指名，运行时按「子会话默认模型设置 > 应用上次使用的模型」解析（不继承任何手动会话） */
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  /** new_session 才用；this_session 跟会话自己的档（这里留着，改投回为新会话时用） */
  mode: AutomationMode;
  status: AutomationStatus;
  endReason?: AutomationEndReason;
  createdBy: AutomationCreator;
  /** 最多跑几次（含手动运行）；到了自动结束 */
  maxRuns?: number;
  /** 终点时刻（epoch ms）；排期越过它自动结束 */
  until?: number;
  /** 下一次到点的时间；非 active 恒为 null */
  nextRunAt: number | null;
  /** 最近 AUTOMATION_RUNS_KEPT 条，新→旧 */
  runs: AutomationRun[];
  /** 已经真正跑过（或送达过）的总次数（不含 skipped）；「第 n 次」与 maxRuns 都按它 */
  runCount: number;
  consecutiveFailures: number;
  /** failed 状态时：最近一次失败的原因（一句话，面板直接显示） */
  failureReason?: string;
  /**
   * this_session 专用：到点时那条会话还在忙，这次送达在**等它空闲**。持久化（重启后空闲了照样送）；
   * 等待期间又到点只把 merged 加一，不叠加。送达时清掉。
   */
  pendingDelivery?: { since: number; trigger: AutomationRunTrigger; merged: number };
  /** 上一次成功运行的最终回答（≤ AUTOMATION_LAST_RESULT_MAX 字），new_session 下一次提示词里的「上次结果」 */
  lastResult?: string;
  createdAt: number;
  updatedAt: number;
}

/** 这条自动化属于哪个工作区（null = Home）——两种去处共用 */
export function automationWorkspaceId(automation: Pick<Automation, "target">): string | null {
  return automation.target.workspaceId;
}

/** 滚动 24 小时内真正跑过的次数（skipped 不计）——24 次上限的口径 */
export function runsInLastDay(automation: Pick<Automation, "runs">, now: number): number {
  const since = now - 24 * 60 * 60 * 1000;
  return automation.runs.filter((run) => run.status !== "skipped" && run.runAt > since).length;
}

/** 有没有一次运行正在跑（面板的转圈图标 / 「上次还在跑」的判定都读它） */
export function isRunning(automation: Pick<Automation, "runs">): boolean {
  return automation.runs.some((run) => run.status === "running");
}

/* ---------- 会话 meta 上的运行标注 ---------- */

/**
 * new_session 开出的会话在 meta 上的标注（`SessionMeta.automationRun`）：会话顶部那条
 * 「任务名 · 第 n 次 · 时间 · 定时/手动」就读它——自动化被删之后这条会话照样认得出自己是谁。
 */
export interface AutomationRunLabel {
  title: string;
  number: number;
  at: number;
  trigger: AutomationRunTrigger;
}

/* ---------- 送进会话的那一行抬头 ---------- */

/** 本机时间 `MM-DD HH:mm`——抬头、会话标题共用，同一个人读的同一个格式 */
export function formatAutomationStamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 到点送进会话的文本抬头：`[定时任务「标题」第 3/12 次 · 10-31 01:45]`（没有上限写「第 3 次」）。
 * renderer 靠 `parseAutomationHeader` 把 this_session 被叫醒的那一轮渲染成一条细分隔线。
 */
export function composeAutomationHeader(input: { title: string; number: number; max?: number; at: number }): string {
  const nth = input.max === undefined ? `${input.number}` : `${input.number}/${input.max}`;
  return `[定时任务「${input.title}」第 ${nth} 次 · ${formatAutomationStamp(input.at)}]`;
}

const HEADER_PATTERN = /^\[定时任务「([^\n]+?)」第 (\d+)(?:\/(\d+))? 次 · ([^\]\n]+)\]\n*([\s\S]*)$/;

/** 认抬头：不是（或残缺）返回 null；body 是抬头之后的指令正文 */
export function parseAutomationHeader(
  text: string,
): { title: string; number: number; max: number | null; stamp: string; body: string } | null {
  const match = HEADER_PATTERN.exec(text);
  if (match === null) return null;
  return {
    title: match[1] ?? "",
    number: Number(match[2]),
    max: match[3] === undefined ? null : Number(match[3]),
    stamp: match[4] ?? "",
    body: match[5] ?? "",
  };
}

/* ---------- 入口载荷（renderer → 主进程） ---------- */

/** 用户在面板里手动新建：只能是 new_session；直接 active */
export interface AutomationCreateInput {
  workspaceId: string | null;
  title: string;
  prompt: string;
  schedule: AutomationSchedule;
  mode: AutomationMode;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  maxRuns?: number;
  until?: number;
}

/** 编辑表单：只改给了的字段；maxRuns / until / 模型给 null = 清掉 */
export interface AutomationPatch {
  title?: string;
  prompt?: string;
  schedule?: AutomationSchedule;
  mode?: AutomationMode;
  providerId?: string | null;
  modelId?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  maxRuns?: number | null;
  until?: number | null;
  /** 改去处：只有 agent 在对话里建的才能在「新开会话」与「投回原会话」之间切 */
  deliver?: "new_session" | "this_session";
}

/**
 * 面板上的按钮 = 状态转移：
 * - `pause` / `resume`：暂停与继续；
 * - `restart`「重新启动」：failed / completed 的任务从头再来（次数清零，从现在重新排期）；
 * - `runNow`「立即运行」：不动排期，现在就跑一次；
 * - `delete`：删掉这条任务（它跑出来的会话不删）。
 */
export type AutomationAction =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "restart" }
  | { type: "runNow" }
  | { type: "delete" };

/** create / update / act 的回执：失败带一句人话；delete 成功时 automation 为 null */
export type AutomationOutcome = { ok: true; automation: Automation | null } | { ok: false; error: string };

/** 主进程 → renderer 的推送：任何一条自动化变了就发，renderer 重拉列表（载荷不带数据，一份真源） */
export type AutomationEvent = { type: "changed" };

/* ---------- agent 工具 ↔ 主进程（requestId 问答，与 delegate 同一条边界） ---------- */

/** 工具给的原样入参，由主进程校验与规整（信任边界在主进程，不在工具） */
export type AutomationToolRequest =
  | {
      op: "create";
      title: string;
      prompt: string;
      schedule: unknown;
      maxRuns?: number;
      until?: number;
      target?: "this_session" | "new_session";
      model?: string;
    }
  | { op: "list" }
  | { op: "cancel"; automationId: string };

/** 对话里那张卡 / 工具回执用的一条自动化摘要（不带指令全文与运行历史） */
export interface AutomationCardView {
  id: string;
  title: string;
  schedule: AutomationSchedule;
  target: "this_session" | "new_session";
  status: AutomationStatus;
  nextRunAt: number | null;
  runCount: number;
  maxRuns?: number;
  until?: number;
}

export function automationCardOf(automation: Automation): AutomationCardView {
  return {
    id: automation.id,
    title: automation.title,
    schedule: automation.schedule,
    target: automation.target.kind,
    status: automation.status,
    nextRunAt: automation.nextRunAt,
    runCount: automation.runCount,
    ...(automation.maxRuns === undefined ? {} : { maxRuns: automation.maxRuns }),
    ...(automation.until === undefined ? {} : { until: automation.until }),
  };
}

/** renderer 读工具结果 details 里的卡：逐字段校验，坏值 null（同 delegateCard 的纪律） */
export function parseAutomationCard(raw: unknown): AutomationCardView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = str(value["id"]);
  const title = str(value["title"]);
  const schedule = parseSchedule(value["schedule"], Number.NEGATIVE_INFINITY);
  const status = value["status"];
  const target = value["target"];
  if (id === null || title === null || !schedule.ok) return null;
  if (!(AUTOMATION_STATUSES as readonly unknown[]).includes(status)) return null;
  if (target !== "this_session" && target !== "new_session") return null;
  const maxRuns = num(value["maxRuns"]);
  const until = num(value["until"]);
  return {
    id,
    title,
    schedule: schedule.schedule,
    target,
    status: status as AutomationStatus,
    nextRunAt: num(value["nextRunAt"]),
    runCount: Math.max(0, Math.floor(num(value["runCount"]) ?? 0)),
    ...(maxRuns !== null ? { maxRuns } : {}),
    ...(until !== null ? { until } : {}),
  };
}

export type AutomationToolOutcome =
  | { ok: true; text: string; automation?: AutomationCardView; automations?: AutomationCardView[] }
  | { ok: false; error: string };

/* ---------- 磁盘解析（逐字段校验，坏的丢掉，不给坏值过路） ---------- */

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRun(raw: unknown): AutomationRun | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = str(value["id"]);
  const runAt = num(value["runAt"]);
  if (id === null || runAt === null) return null;
  const trigger = value["trigger"];
  if (trigger !== "schedule" && trigger !== "manual" && trigger !== "caughtUp") return null;
  const status = value["status"];
  if (status !== "running" && status !== "success" && status !== "error" && status !== "skipped") return null;
  const skipReason = value["skipReason"];
  const repeat = num(value["repeat"]);
  const merged = num(value["merged"]);
  return {
    id,
    runAt,
    trigger,
    status,
    sessionId: str(value["sessionId"]),
    durationMs: num(value["durationMs"]),
    tokens: num(value["tokens"]),
    ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
    ...(skipReason === "overlap" || skipReason === "dailyCap" ? { skipReason } : {}),
    ...(repeat !== null && repeat > 1 ? { repeat: Math.floor(repeat) } : {}),
    ...(merged !== null && merged > 0 ? { merged: Math.floor(merged) } : {}),
    ...(typeof value["resultExcerpt"] === "string" ? { resultExcerpt: value["resultExcerpt"] } : {}),
  };
}

function parseTarget(raw: unknown): AutomationTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const workspaceId = str(value["workspaceId"]);
  if (value["kind"] === "new_session") return { kind: "new_session", workspaceId };
  if (value["kind"] === "this_session") {
    const sessionId = str(value["sessionId"]);
    return sessionId === null ? null : { kind: "this_session", sessionId, workspaceId };
  }
  return null;
}

const END_REASONS: readonly AutomationEndReason[] = ["finished", "expired", "cancelled", "sessionDeleted"];

/** 解磁盘上的一条自动化；字段残缺（没有 id / 标题 / 指令 / 合法触发规则 / 去处 / 状态）整条返回 null，调用方跳过 */
export function parseAutomation(raw: unknown): Automation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = str(value["id"]);
  const title = str(value["title"]);
  const prompt = typeof value["prompt"] === "string" && value["prompt"].trim() !== "" ? value["prompt"] : null;
  if (id === null || title === null || prompt === null) return null;
  // once 的「必须在未来」只管新建；磁盘上的 once 过了点是正常状态，所以这里传 -Infinity 放行
  const schedule = parseSchedule(value["schedule"], Number.NEGATIVE_INFINITY);
  if (!schedule.ok) return null;
  const target = parseTarget(value["target"]);
  if (target === null) return null;
  const status = value["status"];
  if (!(AUTOMATION_STATUSES as readonly unknown[]).includes(status)) return null;
  const parsedStatus = status as AutomationStatus;
  const mode = isAutomationMode(value["mode"]) ? value["mode"] : "plan";
  const creatorRaw = value["createdBy"];
  let createdBy: AutomationCreator = { kind: "user" };
  if (typeof creatorRaw === "object" && creatorRaw !== null) {
    const creator = creatorRaw as Record<string, unknown>;
    const sessionId = str(creator["sessionId"]);
    if (creator["kind"] === "agent" && sessionId !== null) createdBy = { kind: "agent", sessionId };
  }
  const maxRuns = num(value["maxRuns"]);
  const until = num(value["until"]);
  const providerId = str(value["providerId"]);
  const modelId = str(value["modelId"]);
  const thinking = value["thinkingLevel"];
  const lastResult = typeof value["lastResult"] === "string" ? value["lastResult"] : null;
  const endReason = value["endReason"];
  const pendingRaw = value["pendingDelivery"];
  let pending: NonNullable<Automation["pendingDelivery"]> | null = null;
  if (typeof pendingRaw === "object" && pendingRaw !== null) {
    const p = pendingRaw as Record<string, unknown>;
    const since = num(p["since"]);
    if (since !== null && (p["trigger"] === "schedule" || p["trigger"] === "caughtUp" || p["trigger"] === "manual")) {
      pending = { since, trigger: p["trigger"], merged: Math.max(0, Math.floor(num(p["merged"]) ?? 0)) };
    }
  }
  const runs = Array.isArray(value["runs"])
    ? value["runs"].map(parseRun).filter((run): run is AutomationRun => run !== null).slice(0, AUTOMATION_RUNS_KEPT)
    : [];
  const createdAt = num(value["createdAt"]) ?? 0;
  return {
    id,
    title,
    prompt,
    schedule: schedule.schedule,
    target,
    ...(providerId !== null && modelId !== null ? { providerId, modelId } : {}),
    ...(isThinkingLevel(thinking) ? { thinkingLevel: thinking } : {}),
    mode,
    status: parsedStatus,
    ...(parsedStatus === "completed" && (END_REASONS as readonly unknown[]).includes(endReason)
      ? { endReason: endReason as AutomationEndReason }
      : {}),
    createdBy,
    ...(maxRuns !== null && maxRuns >= 1 ? { maxRuns: Math.floor(maxRuns) } : {}),
    ...(until !== null ? { until } : {}),
    nextRunAt: parsedStatus === "active" ? num(value["nextRunAt"]) : null,
    runs,
    runCount: Math.max(0, Math.floor(num(value["runCount"]) ?? 0)),
    consecutiveFailures: Math.max(0, Math.floor(num(value["consecutiveFailures"]) ?? 0)),
    ...(parsedStatus === "failed" && typeof value["failureReason"] === "string" ? { failureReason: value["failureReason"] } : {}),
    ...(parsedStatus === "active" && target.kind === "this_session" && pending !== null ? { pendingDelivery: pending } : {}),
    ...(lastResult !== null && lastResult !== "" ? { lastResult } : {}),
    createdAt,
    updatedAt: num(value["updatedAt"]) ?? createdAt,
  };
}

/** 解 meta 上的运行标注（SessionMeta.automationRun）；坏了 null，当没有 */
export function parseAutomationRunLabel(raw: unknown): AutomationRunLabel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const title = str(value["title"]);
  const number = num(value["number"]);
  const at = num(value["at"]);
  const trigger = value["trigger"];
  if (title === null || number === null || at === null) return null;
  if (trigger !== "schedule" && trigger !== "manual" && trigger !== "caughtUp") return null;
  return { title, number: Math.floor(number), at, trigger };
}
