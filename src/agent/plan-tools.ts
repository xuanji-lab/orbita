/**
 * update_plan：agent 写下这条任务的计划，做一步勾一步（2026-10-30 用户裁决：「要新增一个
 * 写计划的工具」；同日把它定成 agent 与用户对齐的工具：改动要说为什么、顺手看到的事记进
 * 「以后再做」、拿不准时带着具体问题停下来等回答）。
 *
 * **计划不另存**：每次调用都带整张清单（全量替换，不是增量补丁），清单就在这次调用的入参里，
 * 落在转录上。界面（右栏「这条任务 › 进度」）从转录里推出版本线（plan-timeline.ts）——
 * 回退、分支、重开会话都跟着转录走，不会出现「计划还在、对话已经回退」的两份真相。
 *
 * 权限：三档一律放行（shared/permission.ts 的 PLAN_TOOL）——它只是把打算说出来，
 * 不碰用户的文件与 shell；plan 档尤其要用得上。
 *
 * **停下来对齐，在聊天里对齐**（2026-10-30 用户：「我不希望这方面老是找用户确认，打扰用户……要确认可以在聊天框里面
 * 确认，不要在交互页面上让用户点什么确认或者修改……还是以 agent 和用户对齐后，agent 为用户代写为主」）：
 * 下面三种情况写完计划这一轮先停（decidePlanStop）——plan 档、带了 confirm 问题、「先给我看计划」——
 * 但停下的方式是**让 agent 用正文说话**：回执要求它在回复里用自然语言把问题问出来（或说一句要开工请切出 plan 档），
 * 然后这一轮不再调工具；用户在输入框里回答，下一轮 agent 按回答改计划。界面上没有任何确认 / 修改按钮。
 * 不用 pi 的 terminate：它会让这一轮在工具之后直接结束、没有最后一句话，agent 就没机会开口。
 * 「不再调工具」由 createPlanGate 兜底：已决定停之后，本轮其余工具调用在 tool_call 闸门里被拦（返回 block，不抛错），
 * 回执与拦截理由都让它回头用正文说话；下一轮开轮时复位。排在 update_plan **之前**的同批调用闸门已经过了，拦不住——
 * 只读调用照常跑完。
 *
 * 纯模块：回执文案与停下的判定可被 node --test 直接测；计划的形状与校验在 shared/plan.ts。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { diffPlans } from "../shared/plan-diff.ts";
import {
  parsePlanCall,
  parsePlanItemsLoose,
  PLAN_MAX_CONFIRM,
  PLAN_MAX_ITEMS,
  PLAN_MAX_LATER,
  PLAN_STATUSES,
  PLAN_TOOL_NAME,
  type PlanCall,
  type PlanItem,
  type PlanToolDetails,
} from "../shared/plan.ts";
import type { PermissionMode } from "../shared/permission.ts";
import type { PlanDiff } from "../shared/plan-diff.ts";

/** 为什么停：带了问题 / plan 档写完计划 / 用户开了「先给我看计划」 */
export type PlanStopReason = "confirm" | "plan-mode" | "plan-first";

/**
 * 这一次 update_plan 要不要让这一轮停下来等用户。
 * - 带了 confirm 问题：任何档位都停（模型自己判断需要先问）；
 * - plan 档：新计划（没有上一张 / 与上一张一步都对不上）或结构改了就停；只打勾不停——
 *   用户批准后切档继续，或 plan 档里边读边勾，不该每勾一下就停一次；
 * - 「先给我看计划」：只在这个任务的**第一张**计划上停（上一张没有 / 与它一步都对不上）；
 * - 全部已勾完的计划不为 plan 档 / 偏好停（那是收尾，不是要对齐的计划）。
 */
export function decidePlanStop(input: {
  mode: PermissionMode;
  planFirst: boolean;
  call: PlanCall;
  /** 对上一张计划的对齐结果（没有上一张 = fresh 的空对比） */
  diff: PlanDiff;
  hadPlan: boolean;
}): PlanStopReason | null {
  if (input.call.confirm.length > 0) return "confirm";
  if (input.call.items.every((item) => item.status === "done")) return null;
  const isNew = !input.hadPlan || input.diff.fresh;
  if (input.mode === "plan" && (isNew || input.diff.changes.length > 0)) return "plan-mode";
  if (input.planFirst && isNew) return "plan-first";
  return null;
}

/**
 * 本会话上一张计划：从 pi 本子的当前叶子路径里倒着找最近一次 update_plan 的入参。
 * `excludeCallId` 是正在处理的这次调用自己（assistant 消息在工具执行前已落本子，它已经在路径上）。
 * 入参宽松读：坏条目跳过；找不到 = null。
 */
export function previousPlanFrom(branch: readonly unknown[], excludeCallId: string): PlanItem[] | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } } | undefined;
    if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const blocks = entry.message.content as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown }[];
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block?.type !== "toolCall" || block.name !== PLAN_TOOL_NAME || block.id === excludeCallId) continue;
      const items = parsePlanItemsLoose(block.arguments);
      if (items.length > 0) return items;
    }
  }
  return null;
}

/** 回给模型的一句话：几步做完、当前在做哪步。短——模型自己刚写的清单，不用复述 */
export function planReceipt(items: readonly PlanItem[]): string {
  const done = items.filter((item) => item.status === "done").length;
  const current = items.find((item) => item.status === "in_progress");
  const tail = current !== undefined ? ` Now: ${current.text}` : done === items.length ? " All steps done." : "";
  return `Plan updated: ${done}/${items.length} done.${tail}`;
}

/** 停下时回给模型的话：讲清为什么停、该用正文说什么、别再调工具 */
export function stopReceipt(reason: PlanStopReason): string {
  switch (reason) {
    case "confirm":
      return (
        "Plan shown to the user. Your turn pauses here: write your reply now and ask the question(s) from `confirm` " +
        "in plain prose (the user answers in the chat box; there are no buttons), then call no more tools this turn."
      );
    case "plan-mode":
      return (
        "Plan shown to the user. You are in plan mode, so the plan is the deliverable: reply now with a short summary " +
        "and say that to have you start, they need to switch the permission out of plan mode and tell you to go. " +
        "Call no more tools this turn."
      );
    case "plan-first":
      return (
        "Plan shown to the user, who asked to see the plan before any work starts. Reply now in one or two sentences " +
        "(put anything you are unsure about as a question) and call no more tools until they answer in the chat box."
      );
  }
}

/** 一轮之内「已决定停」的标记：update_plan 的闸门置位，本轮其余工具调用据此被拦；下一轮开轮时复位（runtime 的 before_agent_start） */
export interface PlanStopState {
  stopping: boolean;
}

export interface PlanToolOptions {
  /** 当前权限档（读账本：中途切档下一次调用就按新档） */
  getMode: () => PermissionMode;
  /** 「先给我看计划」偏好（随开轮命令来） */
  planFirst: boolean;
  /** pi 本子当前叶子路径（取上一张计划用） */
  branch: () => readonly unknown[];
  state: PlanStopState;
}

/** tool_call 闸门里与计划有关的那一段：已决定停之后拦本轮其余工具调用。返回 null = 不管 */
export function createPlanGate(options: PlanToolOptions) {
  return (event: { toolCallId: string; toolName: string; input: Record<string, unknown> }): { block: true; reason: string } | null => {
    if (event.toolName === PLAN_TOOL_NAME) {
      let call: PlanCall;
      try {
        call = parsePlanCall(event.input);
      } catch {
        return null; // 入参过不了校验：工具会拒，不算「已决定停」
      }
      const previous = previousPlanFrom(options.branch(), event.toolCallId);
      const reason = decidePlanStop({
        mode: options.getMode(),
        planFirst: options.planFirst,
        call,
        diff: diffPlans(previous, call.items),
        hadPlan: previous !== null,
      });
      options.state.stopping = reason !== null;
      return null;
    }
    if (!options.state.stopping) return null;
    return {
      block: true,
      reason:
        "Not run: the plan is shown to the user and this turn is paused for their reply. " +
        "Answer in plain prose now; call this again next turn if it is still needed.",
    };
  };
}

export function createPlanTools(options: PlanToolOptions): ToolDefinition[] {
  const updatePlan: ToolDefinition = {
    name: PLAN_TOOL_NAME,
    label: PLAN_TOOL_NAME,
    // 「做一步勾一步」要说到调用时机（2026-10-30 实测）：只说「做完就勾」时，GLM-5.3 做完第 1 步没勾
    // 就做第 2 步、之后一次勾两步，DeepSeek V4.1 Flash 只在开头和结尾各调一次，右栏的计划一直停在
    // 第 2 步；Kimi K3.1 Pro 把勾和下一步的第一个动作放在同一批里，计划始终跟得上对话，也不多花一个来回——
    // 说明里直接要求这个写法。v4 在此之上加三件事：结构改了要说为什么（why）、顺手看到不做的事记下来
    // （later）、拿不准时带着具体问题停下来（confirm）。
    description:
      "A living list of what you are doing for this task, including things you decide to do along the way; " +
      "the user reads it as a checklist beside the conversation. Use it when the work takes three or more " +
      "distinct steps (changing code, adding tests, running them and updating docs are separate steps); skip " +
      "it for quick questions and one-step changes. Write it as soon as you know the steps: right away, or " +
      "after a first look around. Each step should end in something checkable: a changed file, a passing " +
      "check, or a decision; most tasks need 3-7 steps. Send the whole list every time (it replaces the " +
      "previous one). Exactly one step is in_progress while you work. Tick as you go: each time you move on, " +
      "call update_plan again in the same batch as the next step's first tool call, marking the finished step " +
      "done and the next one in_progress. Do not start a later step while an earlier one still shows " +
      "in_progress, and do not save the ticks for the end. If you find work the plan does not cover (a bug in " +
      "code you depend on, a missing prerequisite, a failing check), send the list again with that work as its " +
      "own step before you do it; never fold it silently into another step. Whenever you add, drop, split, " +
      "merge, reword or reorder steps, pass `why`: one short clause the user will read (for example \"tests " +
      "showed dueBefore compares UTC midnight\"); leave it out when you only tick. Things you notice but will " +
      "not do in this task (a nearby bug, a cleanup, a follow-up) go in `later` the moment you notice them, " +
      "one short phrase each (only the new ones; they are saved for the user). If you cannot go on without the user's " +
      "answer, because the request is ambiguous or the next step is irreversible, costly or wide-reaching, put " +
      `1-${PLAN_MAX_CONFIRM} concrete questions in \`confirm\`, and then ask them in plain prose in your reply: ` +
      "the user answers in the chat box, there are no buttons, and you make no more tool calls until they do. " +
      "Otherwise do not stop to ask; write the plan and get on with it. Steps are short, " +
      "outcome-focused phrases in the user's language.",
    // 第三条（2026-11-06 用户）：用户中途提了计划外的新活（「先修一个 bug」），智能体直接开干、计划还停在
    // 旧任务上——「它不会去适当地调整那个 plan 然后再开始干活」。前两条只管「做的过程中发现的」活。
    // 规则放进系统提示的 Guidelines（promptGuidelines，随工具启用、整会话不变）：只写在工具说明里时，
    // Kimi K3.1 Pro 实测两次发现计划没覆盖的问题（顺带修了 completeTask、兼容了旧日期），嘴上说了
    // 「我会先修正」却照旧只打勾、没加步骤、没写 why / later（2026-10-30）
    promptSnippet: "Write and update the task's plan; the user follows it as a checklist",
    promptGuidelines: [
      "Keep the plan honest. When you find work it does not cover (a bug you have to fix first, a missing prerequisite, a failing check), call update_plan with that work as its own step and a `why` BEFORE you do it. Saying it in prose, or folding it into another step, leaves the user's checklist wrong.",
      "When you notice something worth doing but decide not to do it in this task, put it in update_plan's `later` right then, not at the end.",
      "When the user's new message asks for something the current plan does not cover (a bug to look into, another change, a side question that takes several steps), update the plan before you start on it: add it as its own step or steps with a `why` that names the request, keep the unfinished earlier steps (mark them done, or keep them pending if you will come back to them), and if earlier work keeps running alongside (a sub-session you delegated), say so in that step's text. A new request is not a reason to drop the plan or to work outside it.",
    ],
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
        why: {
          type: "string",
          description: "Only when the steps themselves changed (added, dropped, split, merged, reworded, reordered): one short clause saying why.",
        },
        later: {
          type: "array",
          description: `Things you noticed but will not do in this task (at most ${PLAN_MAX_LATER}); list only new ones.`,
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The thing to do later, one short phrase." },
              why: { type: "string", description: "Why not now (optional)." },
            },
            required: ["text"],
          },
        },
        confirm: {
          type: "array",
          description: `1-${PLAN_MAX_CONFIRM} concrete questions the user must answer before you go on; also ask them in your reply text.`,
          items: { type: "string" },
        },
      },
      required: ["items"],
    } as never,
    async execute(toolCallId, params) {
      const call = parsePlanCall(params);
      const previous = previousPlanFrom(options.branch(), toolCallId);
      const diff = diffPlans(previous, call.items);
      const reason = decidePlanStop({
        mode: options.getMode(),
        planFirst: options.planFirst,
        call,
        diff,
        hadPlan: previous !== null,
      });
      const details: PlanToolDetails = {
        plan: call.items,
        ...(reason === null ? {} : { awaiting: true }),
      };
      const lines = [planReceipt(call.items)];
      // 改了结构却没写理由：提醒一句，不拒——拒一次就多一个来回
      if (previous !== null && !diff.fresh && diff.changes.length > 0 && call.why === null) {
        lines.push("The steps changed: next time pass `why` (one short clause) so the user sees the reason.");
      }
      if (call.later.length > 0) lines.push(`Noted ${call.later.length} for later.`);
      if (reason !== null) lines.push(stopReceipt(reason));
      return {
        content: [{ type: "text", text: lines.join(" ") }],
        details,
      };
    },
  };
  return [updatePlan];
}
