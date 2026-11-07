/**
 * update_plan：agent 写下这条任务的计划，做完一步勾一步（2026-10-30 用户裁决：「要新增一个
 * 写计划的工具」）。
 *
 * **计划不另存**：每次调用都带整张清单（全量替换，不是增量补丁），清单就在这次调用的入参里，
 * 落在转录上。界面（右栏「这条任务 › 进度」）从转录里取最后一次 update_plan 的入参即可——
 * 回退、分支、重开会话都跟着转录走，不会出现「计划还在、对话已经回退」的两份真相。
 *
 * 权限：三档一律放行（shared/permission.ts 的 PLAN_TOOL）——它只是把打算说出来，
 * 不碰用户的文件与 shell；plan 档尤其要用得上。
 *
 * 纯模块：校验与回执文案可被 node --test 直接测。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const PLAN_TOOL_NAME = "update_plan";

export type PlanItemStatus = "pending" | "in_progress" | "done";

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

/** 一张计划的上限：再多就不是计划，是流水账 */
export const PLAN_MAX_ITEMS = 12;

const STATUSES: readonly PlanItemStatus[] = ["pending", "in_progress", "done"];

/**
 * 入参 → 计划清单。坏入参抛错（错误文案回灌给模型，让它改了重调）：
 * - items 必须是 1–12 条；text 去空白后不能为空；status 只认三个值；
 * - **最多一条 in_progress**：同时「在做」两件事，界面上的「当前一步」就说不清了。
 */
export function parsePlan(params: unknown): PlanItem[] {
  const raw = (params as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('update_plan requires "items": a list of 1-12 steps, each { text, status }.');
  }
  if (raw.length > PLAN_MAX_ITEMS) {
    throw new Error(`A plan has at most ${PLAN_MAX_ITEMS} steps (got ${raw.length}). Merge smaller steps.`);
  }
  const items = raw.map((item, index): PlanItem => {
    const record = (item ?? {}) as Record<string, unknown>;
    const text = typeof record["text"] === "string" ? record["text"].trim() : "";
    if (text === "") throw new Error(`Step ${index + 1} has no text.`);
    const status = record["status"];
    if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
      throw new Error(`Step ${index + 1} has status "${String(status)}"; use pending, in_progress or done.`);
    }
    return { text, status: status as PlanItemStatus };
  });
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("Only one step can be in_progress at a time.");
  }
  return items;
}

/** 回给模型的一句话：几步做完、当前在做哪步。短——模型自己刚写的清单，不用复述 */
export function planReceipt(items: readonly PlanItem[]): string {
  const done = items.filter((item) => item.status === "done").length;
  const current = items.find((item) => item.status === "in_progress");
  const tail = current !== undefined ? ` Now: ${current.text}` : done === items.length ? " All steps done." : "";
  return `Plan updated: ${done}/${items.length} done.${tail}`;
}

export function createPlanTools(): ToolDefinition[] {
  const updatePlan: ToolDefinition = {
    name: PLAN_TOOL_NAME,
    label: PLAN_TOOL_NAME,
    description:
      "Write down your plan for this task and keep it current; the user sees it as a checklist beside " +
      "the conversation. Use it when the work takes three or more distinct steps; skip it for quick " +
      "questions and one-step changes. Send the whole list every time (it replaces the previous one). " +
      "Keep exactly one step in_progress while you work, mark a step done as soon as it is finished, " +
      "and add or reword steps when the plan changes. Steps are short, outcome-focused phrases in the " +
      "user's language.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: `The full plan, 1-${PLAN_MAX_ITEMS} steps in order.`,
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "What this step achieves, one short phrase." },
              status: { type: "string", enum: STATUSES, description: "pending, in_progress or done." },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["items"],
    } as never,
    async execute(_toolCallId, params) {
      const items = parsePlan(params);
      return { content: [{ type: "text", text: planReceipt(items) }], details: { plan: items } };
    },
  };
  return [updatePlan];
}
