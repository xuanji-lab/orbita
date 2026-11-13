import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../shared/permission.ts";
import { RequestBroker } from "./request-broker.ts";
import {
  AUTOMATION_AGENT_DEFAULT_MAX_RUNS,
  AUTOMATION_AGENT_MAX_RUNS_CAP,
  AUTOMATION_INTERVAL_MIN_MINUTES,
  AUTOMATION_MAX_RUNS_PER_DAY,
  type AutomationCardView,
  type AutomationModeRow,
  type AutomationToolOutcome,
  type AutomationToolRequest,
} from "../shared/automation.ts";

/**
 * agent 的自动化工具：automation_create / automation_list / automation_cancel / automation_update。
 *
 * 自动化是**工作区里那个主 agent 的工具**，不是某个会话上的工具卡：只管当前会话所在工作区的。
 * 建出来**直接生效**（用户 2026-10-31 裁决）：默认绑定创建它的这条会话——到点把指令送回这条会话，
 * 让长任务放后台、本轮结束，而不是在 bash 里 sleep 轮询。照 delegate 的范式：agent 进程只把参数翻成
 * automationRequest、把回执翻成工具结果，校验与存盘都在主进程（信任边界在那边，这里的校验只是让模型少撞一次墙）。
 *
 * 只给根会话注册（主进程按 automationTools 开关装配）；自动化新开的会话与
 * 子会话不注册——自动化不能再建自动化。
 */

/** 工具名（权限名单在 shared/permission.ts 的 AUTOMATION_TOOLS，两处同名） */
export const AUTOMATION_TOOL_NAMES = ["automation_create", "automation_list", "automation_cancel", "automation_update"] as const;

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
    ...(card.plugin === undefined ? [] : [`plugin ${card.plugin}`]),
  ];
  return `- ${card.id} · "${card.title}" · ${bits.join(" · ")}`;
}

function toToolResult(outcome: AutomationToolOutcome): {
  content: { type: "text"; text: string }[];
  details: { automation?: AutomationCardView; automationMode?: AutomationModeRow } | undefined;
} {
  if (!outcome.ok) throw new Error(outcome.error);
  const lines = outcome.automations === undefined ? [] : outcome.automations.map(describeCard);
  const text = lines.length === 0 ? outcome.text : `${outcome.text}\n${lines.join("\n")}`;
  // details.automation 是 renderer 画对话卡的素材（create 才有）：与 delegate 的 details.delegate 同款；
  // details.automationMode 是对话里「改权限」那一行（已改成放行 / 待你点「允许」），与 install_plugin 的 details.pluginInstall 同款
  const details = {
    ...(outcome.automation === undefined ? {} : { automation: outcome.automation }),
    ...(outcome.modeRow === undefined ? {} : { automationMode: outcome.modeRow }),
  };
  return { content: [{ type: "text", text }], details: Object.keys(details).length === 0 ? undefined : details };
}

/** getMode 读这条会话此刻的权限档：主进程据它决定「skip」直接改还是留一行让用户点 */
export function createAutomationTools(broker: RequestBroker, sessionId: string, getMode: () => PermissionMode): ToolDefinition[] {
  const send = (request: AutomationToolRequest): Promise<AutomationToolOutcome> =>
    broker.request<AutomationToolOutcome>({ type: "automationRequest", sessionId, mode: getMode(), request });

  const create: ToolDefinition = {
    name: "automation_create",
    label: "automation_create",
    description:
      "Schedule a recurring or one-off task for THIS workspace; it takes effect immediately and shows the user a card. " +
      'Use it for anything to happen later or repeatedly: "every Friday morning check X", "remind me tomorrow at 9", "check back in 20 minutes", "tell me when the build is done". ' +
      'Target "this_session" (default): when due, your instruction is sent back into THIS conversation. ' +
      'Target "new_session": each run opens a fresh read-only session, so the instruction must be self-contained. ' +
      "For a long-running job, start it in the background, create a this_session task that checks on it, and END YOUR TURN. Do NOT sleep or poll in bash. " +
      "Check automation_list first so you do not duplicate an existing task. " +
      'Write access: never pass mode "skip" yourself — ask the user in ONE plain sentence first, and only after they agree call automation_update. ' +
      `Limits: intervals of at least ${AUTOMATION_INTERVAL_MIN_MINUTES} minutes, at most ${AUTOMATION_MAX_RUNS_PER_DAY} runs per 24 hours; ` +
      `it stops after ${AUTOMATION_AGENT_DEFAULT_MAX_RUNS} runs if you give neither maxRuns nor until (maxRuns at most ${AUTOMATION_AGENT_MAX_RUNS_CAP}); ` +
      "at most 5 active tasks per conversation, 20 in total; times are local. " +
      "Before the first automation_create in a conversation, read the `automation` skill (schedule format, writing the instruction, long jobs, write access).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name on the card (≤ 40 characters)." },
        prompt: {
          type: "string",
          description: "The instruction each run receives. new_session runs cannot see this conversation: make it self-contained.",
        },
        schedule: {
          type: "object",
          description: "When to run: pick a kind and give its fields (local time; once needs an ISO 8601 time with offset). Formats and examples: `automation` skill.",
          properties: {
            kind: { type: "string", enum: ["interval", "hourly", "daily", "monthly", "once"] },
            unit: { type: "string", enum: ["minute", "hour", "day"], description: "interval: unit of every." },
            every: { type: "integer", minimum: 1, description: "interval: every N units." },
            minute: { type: "integer", minimum: 0, maximum: 59, description: "hourly: minute past the hour." },
            time: { type: "string", description: 'daily / monthly: "HH:MM" local.' },
            weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "daily: optional, 0 = Sunday." },
            day: { type: "integer", minimum: 1, maximum: 31, description: "monthly: day of month." },
            at: { type: "string", description: "once: ISO 8601 with offset." },
          },
          required: ["kind"],
        },
        maxRuns: {
          type: "integer",
          minimum: 1,
          maximum: AUTOMATION_AGENT_MAX_RUNS_CAP,
          description: `Stop after this many runs (default ${AUTOMATION_AGENT_DEFAULT_MAX_RUNS} if no until either).`,
        },
        until: { type: "string", description: "Stop at this time (ISO 8601 with offset)." },
        target: {
          type: "string",
          enum: ["this_session", "new_session"],
          description: 'Where each run goes; default "this_session".',
        },
        mode: {
          type: "string",
          enum: ["plan", "skip"],
          description: 'new_session only; default "plan" (read-only). Do not pass "skip" before the user agreed to write access.',
        },
        model: { type: "string", description: "Model id for the runs; new_session only." },
        plugin: { type: "string", description: "Name of an installed plugin to run each time; its board cards go on the weekly board." },
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
        ...(typeof args["plugin"] === "string" && args["plugin"].trim() !== "" ? { plugin: args["plugin"].trim() } : {}),
        ...(args["mode"] === "plan" || args["mode"] === "skip" ? { mode: args["mode"] } : {}),
      };
      return toToolResult(await send(request));
    },
  };

  const list: ToolDefinition = {
    name: "automation_list",
    label: "automation_list",
    description:
      "List this workspace's automations (all statuses) with schedule, target, run count and next run. Check it before creating one, so you do not duplicate a task; ids come from here.",
    parameters: { type: "object", properties: {} } as never,
    async execute() {
      return toToolResult(await send({ op: "list" }));
    },
  };

  const cancel: ToolDefinition = {
    name: "automation_cancel",
    label: "automation_cancel",
    description:
      "Cancel an automation of this workspace (it will not run again). Use it when the job a this_session task was watching is done. Ids: automation_list.",
    parameters: {
      type: "object",
      properties: { automationId: { type: "string", description: "The automation's id." } },
      required: ["automationId"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      return toToolResult(await send({ op: "cancel", automationId: requireString(args["automationId"], "automationId") }));
    },
  };

  const update: ToolDefinition = {
    name: "automation_update",
    label: "automation_update",
    description:
      'Change the permission of a new_session automation: "skip" = unattended with write access, "plan" = read-only. Nothing else can be changed here. ' +
      "Ask the user in one plain sentence first and call this only after they agree. " +
      "An automation never gets more permission than this conversation has: if this one is not in Skip mode NOTHING changes — a row with an allow button is left for the user to click; " +
      "then end your turn and do not call it again. Ids: automation_list. Details: `automation` skill.",
    parameters: {
      type: "object",
      properties: {
        automationId: { type: "string", description: "The automation's id." },
        mode: { type: "string", enum: ["plan", "skip"], description: '"skip" only after the user agreed.' },
      },
      required: ["automationId", "mode"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      if (args["mode"] !== "plan" && args["mode"] !== "skip") throw new Error('"mode" must be "plan" or "skip".');
      return toToolResult(await send({ op: "update", automationId: requireString(args["automationId"], "automationId"), mode: args["mode"] }));
    },
  };

  return [create, list, cancel, update];
}
