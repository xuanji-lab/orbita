/**
 * update_goal：agent 替用户记下这个会话的长期目标（2026-10-30）。
 *
 * 用户 14:23 原话：「session 级别主要就是用户不希望模型偏离的目标……我不希望这方面老是找用户确认，打扰用户。
 * 你要确认可以在聊天框里面确认，不要在交互页面上让用户点什么确认或者修改……这个东西还是以 agent 和用户对齐后，
 * agent 为用户代写为主。」所以：
 * - 目标由 agent 从用户的话里提炼，**以用户原话为主**；用户在聊天里改了说法，agent 重新调一次，并在**回复正文**里
 *   说一句「目标我改成了 X」——回执里提醒它说，界面上没有确认按钮；
 * - 工具本身不停下、不等回答：记下来就完事（与 update_plan 的 confirm 停下是两回事）。
 *
 * 目标不另存：入参就是账，落在转录上；最后一次有效的调用 = 当前目标。界面（右栏进度最上面一行）与压缩时的
 * 固定附段（goal-compaction.ts）都从转录推，回退 / 分支 / 重开会话跟着走。
 *
 * 纯模块：不 import electron，回执文案与上一个目标的查找可被 node --test 直接测。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GOAL_TOOL_NAME, parseGoalCall, parseGoalCallLoose, type GoalToolDetails } from "../shared/goal.ts";

/**
 * 本会话上一个目标：从 pi 本子的当前叶子路径里倒着找最近一次 update_goal 的入参。
 * `excludeCallId` 是正在处理的这次调用自己（assistant 消息在工具执行前已落本子，它已经在路径上）。
 * 入参宽松读：坏的跳过；找不到 = null。
 */
export function previousGoalFrom(branch: readonly unknown[], excludeCallId: string): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } } | undefined;
    if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const blocks = entry.message.content as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown }[];
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block?.type !== "toolCall" || block.name !== GOAL_TOOL_NAME || block.id === excludeCallId) continue;
      const call = parseGoalCallLoose(block.arguments);
      if (call !== null) return call.goal;
    }
  }
  return null;
}

/** 回给模型的话：第一次 / 没变 / 改了。改了要提醒它在正文里说一句——这是用户在界面上唯一的「确认」 */
export function goalReceipt(previous: string | null, next: string): string {
  if (previous === null) return "Goal saved. It is shown at the top of the user's progress panel; plan steps (update_plan) hang under it.";
  if (previous === next) return "Goal unchanged.";
  return (
    "Goal changed. Now tell the user in one plain sentence in your reply, in their language " +
    '(for example "目标我改成了 …" or "I changed the goal to …"); do not ask them to confirm.'
  );
}

export function createGoalTools(options: { branch: () => readonly unknown[] }): ToolDefinition[] {
  const updateGoal: ToolDefinition = {
    name: GOAL_TOOL_NAME,
    label: GOAL_TOOL_NAME,
    description:
      "The long-lived goal of this conversation: what the user wants out of the whole thing, which may take " +
      "several turns or more than one session. Write it mostly in the user's own words; do not turn it into " +
      "your plan (steps belong in update_plan, which sits under the goal). Set it once the user's objective " +
      "is clear and will take more than a single reply; skip it for quick questions and one-off tasks. " +
      "When the user restates, narrows, widens or drops part of what they want, call update_goal again with " +
      "the new wording and `why` (one short clause: what changed); this is how their change is recorded, so " +
      "never ask them to confirm it, and say it in one plain sentence in your reply. Send the whole goal every " +
      "time (it replaces the previous one). Pass by=\"self\" only when you changed the goal on your own, " +
      "without the user asking (say what you found in `why`); otherwise leave `by` out.",
    promptSnippet: "Record the conversation's long-lived goal in the user's words; plan steps hang under it",
    promptGuidelines: [
      "Keep the session goal honest. When the user states or changes what they want from this conversation, call update_goal with their wording right away (no permission or confirmation needed), and tell them in one sentence in your reply what you changed it to. Call it only when the long-lived objective is new or changes, not for every message.",
    ],
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The whole goal, mostly the user's own words, one or two sentences.",
        },
        why: {
          type: "string",
          description: "Only when changing an existing goal: one short clause saying what changed.",
        },
        by: {
          type: "string",
          enum: ["user", "self"],
          description: 'Leave out when the user\'s message caused this. "self" only when you changed the goal on your own.',
        },
      },
      required: ["goal"],
    } as never,
    async execute(toolCallId, params) {
      const call = parseGoalCall(params);
      const previous = previousGoalFrom(options.branch(), toolCallId);
      const details: GoalToolDetails = {
        goal: call.goal,
        ...(previous !== null && previous !== call.goal ? { previous } : {}),
      };
      return { content: [{ type: "text", text: goalReceipt(previous, call.goal) }], details };
    },
  };
  return [updateGoal];
}
