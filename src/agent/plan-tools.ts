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
 * 纯模块：回执文案可被 node --test 直接测；计划的形状与校验在 shared/plan.ts（右栏面板也用它认计划）。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parsePlan, PLAN_MAX_ITEMS, PLAN_STATUSES, PLAN_TOOL_NAME, type PlanItem } from "../shared/plan.ts";

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
    // 「做一步勾一步」要说到调用时机（2026-10-30 实测）：只说「做完就勾」时，GLM-5.3 做完第 1 步没勾
    // 就做第 2 步、之后一次勾两步，DeepSeek V4.1 Flash 只在开头和结尾各调一次，右栏的计划一直停在
    // 第 2 步；Kimi K3.1 Pro 把勾和下一步的第一个动作放在同一批里，计划始终跟得上对话，也不多花一个来回——
    // 说明里直接要求这个写法。
    description:
      "Write down your plan for this task and keep it current; the user watches it as a checklist " +
      "beside the conversation. Use it when the work takes three or more distinct steps (changing code, " +
      "adding tests, running them and updating docs are separate steps); skip it for quick questions " +
      "and one-step changes. Write it as soon as you know the steps: right away, or after a first look " +
      "around. Send the whole list every time (it replaces the previous one). Exactly one step is " +
      "in_progress while you work. Each time you move on, call update_plan again in the same batch as " +
      "the next step's first tool call, marking the finished step done and the next one in_progress. " +
      "Do not start a later step while an earlier one still shows in_progress, and do not save the " +
      "ticks for the end. Add or reword steps when the plan changes. Steps are short, outcome-focused " +
      "phrases in the user's language.",
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
              status: { type: "string", enum: PLAN_STATUSES, description: "pending, in_progress or done." },
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
