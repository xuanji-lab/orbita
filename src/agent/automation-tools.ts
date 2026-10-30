import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import {
  AUTOMATION_AGENT_DEFAULT_MAX_RUNS,
  AUTOMATION_AGENT_MAX_RUNS_CAP,
  AUTOMATION_INTERVAL_MIN_MINUTES,
  AUTOMATION_MAX_RUNS_PER_DAY,
  type AutomationCardView,
  type AutomationToolOutcome,
  type AutomationToolRequest,
} from "../shared/automation.ts";

/**
 * agent 的自动化工具（实验功能 automation）：automation_create / automation_list / automation_cancel。
 *
 * 自动化是**工作区里那个主 agent 的工具**，不是某个会话上的工具卡：只管当前会话所在工作区的。
 * 建出来**直接生效**（用户 2026-10-31 裁决）：默认绑定创建它的这条会话——到点把指令送回这条会话，
 * 让长任务放后台、本轮结束，而不是在 bash 里 sleep 轮询。照 delegate 的范式：agent 进程只把参数翻成
 * automationRequest、把回执翻成工具结果，校验与存盘都在主进程（信任边界在那边，这里的校验只是让模型少撞一次墙）。
 *
 * 只给根会话注册、且实验开关开着时注册（主进程按 automationTools 开关装配）；自动化新开的会话与
 * 子会话不注册——自动化不能再建自动化。
 */

/** 工具名（权限名单在 shared/permission.ts 的 AUTOMATION_TOOLS，两处同名） */
export const AUTOMATION_TOOL_NAMES = ["automation_create", "automation_list", "automation_cancel"] as const;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required and must be a non-empty string.`);
  }
  return value;
}

/** ISO 8601 时间 → epoch ms；解析不出抛带字段名的说明（模型能据此改正） */
function parseIsoTime(value: unknown, field: string): number {
  if (typeof value !== "string") throw new Error(`"${field}" must be an ISO 8601 date-time string.`);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    throw new Error(`"${field}" is not a valid ISO 8601 date-time (e.g. 2026-11-02T09:00:00+08:00): ${JSON.stringify(value)}`);
  }
  return at;
}

/**
 * 把模型给的 schedule 翻成契约形状：once 用 ISO 字符串（转 ms）；interval 也认 `everyMinutes` 的简写。
 * 其余原样交主进程校验。
 */
export function toScheduleRequest(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) throw new Error('"schedule" is required and must be an object.');
  const schedule = raw as Record<string, unknown>;
  if (schedule["kind"] === "once") return { kind: "once", at: parseIsoTime(schedule["at"], "schedule.at") };
  if (schedule["kind"] === "interval" && schedule["every"] === undefined && schedule["everyMinutes"] !== undefined) {
    return { kind: "interval", unit: "minute", every: schedule["everyMinutes"] };
  }
  return schedule;
}

function describeCard(card: AutomationCardView): string {
  const bits = [
    card.status,
    card.target === "this_session" ? "sent back into its session" : "new session each run",
    `${card.runCount} run(s)${card.maxRuns === undefined ? "" : ` of ${card.maxRuns}`}`,
    card.nextRunAt === null ? "no next run" : `next ${new Date(card.nextRunAt).toISOString()}`,
  ];
  return `- ${card.id} · "${card.title}" · ${bits.join(" · ")}`;
}

function toToolResult(outcome: AutomationToolOutcome): {
  content: { type: "text"; text: string }[];
  details: { automation: AutomationCardView } | undefined;
} {
  if (!outcome.ok) throw new Error(outcome.error);
  const lines = outcome.automations === undefined ? [] : outcome.automations.map(describeCard);
  const text = lines.length === 0 ? outcome.text : `${outcome.text}\n${lines.join("\n")}`;
  // details.automation 是 renderer 画对话卡的素材（create 才有）：与 delegate 的 details.delegate 同款
  return { content: [{ type: "text", text }], details: outcome.automation === undefined ? undefined : { automation: outcome.automation } };
}

export function createAutomationTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
  const send = (request: AutomationToolRequest): Promise<AutomationToolOutcome> =>
    broker.request<AutomationToolOutcome>({ type: "automationRequest", sessionId, request });

  const create: ToolDefinition = {
    name: "automation_create",
    label: "automation_create",
    description:
      "Schedule a recurring or one-off task for THIS workspace. It takes effect immediately and shows the user a card. " +
      "Default target \"this_session\": each time it is due, your instruction is sent back into THIS conversation — so for a long-running job " +
      "(a build, a training run, a server starting up), start it in the background, create a this_session task that checks on it every few minutes, " +
      "and END YOUR TURN. Do NOT sleep or poll in bash. If the conversation is still busy when the task is due, delivery waits until it is idle. " +
      "Write the instruction so that you, coming back with this conversation's history, know exactly what to check and when to stop " +
      "(you can call automation_cancel on it once the job is done). " +
      "Target \"new_session\" is for routines independent of this conversation (\"every Friday, scan release notes of X and report what is new\"): " +
      "each run opens a fresh session in this workspace, read-only (Plan) unless the user changes it in the Automations panel, and the previous run's answer is attached so it can say what is new; the instruction must then be self-contained. " +
      `Limits: intervals of at least ${AUTOMATION_INTERVAL_MIN_MINUTES} minutes, at most ${AUTOMATION_MAX_RUNS_PER_DAY} runs per 24 hours; ` +
      `a task you create always has an end — if you give neither maxRuns nor until it stops after ${AUTOMATION_AGENT_DEFAULT_MAX_RUNS} runs (maxRuns at most ${AUTOMATION_AGENT_MAX_RUNS_CAP}); ` +
      "at most 5 active tasks per conversation and 20 in total. Times are local time. Three consecutive failed runs stop it. " +
      "Check automation_list first so you do not duplicate an existing task.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name shown on the card (at most 40 characters)." },
        prompt: {
          type: "string",
          description:
            "The instruction for each run. For this_session it is delivered into this conversation; for new_session the run cannot see this conversation, so make it self-contained.",
        },
        schedule: {
          type: "object",
          description:
            'When to run. One of: {"kind":"interval","unit":"minute","every":15} (unit minute|hour|day; at least ' +
            `${AUTOMATION_INTERVAL_MIN_MINUTES} minutes in total); {"kind":"hourly","minute":0}; ` +
            '{"kind":"daily","time":"09:00","weekdays":[1,2,3,4,5]} (local time; weekdays optional, 0 = Sunday); ' +
            '{"kind":"monthly","day":1,"time":"09:00"}; {"kind":"once","at":"2026-11-02T09:00:00+08:00"} (ISO 8601 with offset, in the future).',
          properties: {
            kind: { type: "string", enum: ["interval", "hourly", "daily", "monthly", "once"] },
            unit: { type: "string", enum: ["minute", "hour", "day"], description: "interval: unit of every." },
            every: { type: "integer", minimum: 1, description: "interval: every N units." },
            minute: { type: "integer", minimum: 0, maximum: 59, description: "hourly: minute past the hour." },
            time: { type: "string", description: 'daily / monthly: "HH:MM" 24-hour local time.' },
            weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "daily: optional days of week, 0 = Sunday." },
            day: { type: "integer", minimum: 1, maximum: 31, description: "monthly: day of month (31 falls on the last day of shorter months)." },
            at: { type: "string", description: "once: ISO 8601 date-time with offset." },
          },
          required: ["kind"],
        },
        maxRuns: {
          type: "integer",
          minimum: 1,
          maximum: AUTOMATION_AGENT_MAX_RUNS_CAP,
          description: `Stop after this many runs. Default ${AUTOMATION_AGENT_DEFAULT_MAX_RUNS} when neither maxRuns nor until is given.`,
        },
        until: { type: "string", description: "Stop at this time (ISO 8601 with offset, in the future)." },
        target: {
          type: "string",
          enum: ["this_session", "new_session"],
          description: 'Where each run goes. Default "this_session" (sent back into this conversation).',
        },
        model: { type: "string", description: 'Optional model id for the runs; only with target "new_session". Default: the sub-session default model setting.' },
      },
      required: ["title", "prompt", "schedule"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const request: AutomationToolRequest = {
        op: "create",
        title: requireString(args["title"], "title"),
        prompt: requireString(args["prompt"], "prompt"),
        schedule: toScheduleRequest(args["schedule"]),
        ...(args["maxRuns"] === undefined ? {} : { maxRuns: args["maxRuns"] as number }),
        ...(args["until"] === undefined ? {} : { until: parseIsoTime(args["until"], "until") }),
        ...(args["target"] === "this_session" || args["target"] === "new_session" ? { target: args["target"] } : {}),
        ...(typeof args["model"] === "string" && args["model"].trim() !== "" ? { model: args["model"] } : {}),
      };
      return toToolResult(await send(request));
    },
  };

  const list: ToolDefinition = {
    name: "automation_list",
    label: "automation_list",
    description:
      "List the automations of this workspace (all statuses: active, paused, failed, completed) with their schedule, target, run count and next run. " +
      "Check this before creating one, so you do not duplicate an existing task.",
    parameters: { type: "object", properties: {} } as never,
    async execute() {
      return toToolResult(await send({ op: "list" }));
    },
  };

  const cancel: ToolDefinition = {
    name: "automation_cancel",
    label: "automation_cancel",
    description:
      "Cancel an automation of this workspace (it will not run again; sessions it already started stay). " +
      "Use it when the job a this_session task was watching is done. Use automation_list for the ids.",
    parameters: {
      type: "object",
      properties: { automationId: { type: "string", description: "The automation's id (from automation_list or automation_create)." } },
      required: ["automationId"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      return toToolResult(await send({ op: "cancel", automationId: requireString(args["automationId"], "automationId") }));
    },
  };

  return [create, list, cancel];
}
