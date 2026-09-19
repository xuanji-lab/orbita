import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import type { ReadTaskCard, ReadTaskOutcome, StartTaskCard, StartTaskOutcome } from "../shared/agent-ipc.ts";

/**
 * agent 的「跨 task」工具族：read_task（B-1，只读）+ start_task（B-2，派发）。
 *
 * 读盘与开轮都在主进程（agent 进程不碰 userData、不碰 provider 密钥）——
 * requestId 问答，见 ./request-broker.ts。
 * 权限：read_task 在 READ_ONLY_TOOLS（plan 静默放行，2026-09-18 二次裁决）；
 * start_task 是非只读——派发立刻花真钱开一轮，manual / plan 弹一次审批，
 * skip 放行（grill 2026-09-19）。
 * 结果的 text 进模型上下文；card 挂 `details`——details 的明文语义是「只给 UI、
 * 不入模型上下文」（edit 的 diff 是先例），renderer 的任务卡与跳转吃它。
 */

/** 派发走的是同一套主进程装配（dispatch.ts），工具侧只管把参数原样递过去。 */
export function createTaskTools(
  broker: RequestBroker,
  sessionId: string,
  /** B-2：这条会话能不能派子 task。子会话（canDispatch=false）根本看不到 start_task */
  canDispatch: boolean,
): ToolDefinition[] {
  const readTask: ToolDefinition = {
    name: "read_task",
    label: "read_task",
    description:
      "Read another task's transcript (read-only). " +
      'Call without "rounds" first: you get the header, a table of contents (one line per round) ' +
      "and the most recent rounds in full. " +
      'To read specific older rounds, call again with "rounds" using the numbers from the contents, e.g. "3", "2-5" or "1,4". ' +
      '"task" matches by exact id, exact title, or unique prefix; an ambiguous match returns the candidates.',
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Which task to read: its id, its exact title, or a unique prefix of either.",
        },
        rounds: {
          type: "string",
          description: 'Round numbers from the contents, e.g. "3", "2-5", "1,4". Omit for the overview.',
        },
      },
      required: ["task"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const roundsRaw = args["rounds"];
      const rounds = typeof roundsRaw === "string" && roundsRaw.trim() !== "" ? roundsRaw : undefined;
      const result = await broker.request<ReadTaskOutcome>({
        type: "readTaskRequest",
        sessionId,
        task: String(args["task"] ?? ""),
        ...(rounds === undefined ? {} : { rounds }),
      });
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: "text", text: result.text }],
        details: { readTask: result.card satisfies ReadTaskCard },
      };
    },
  };

  /**
   * start_task（B-2）：开一条子 task、交一句话，**不等结果**。工具描述承担了
   * 规格里「教模型写自包含 prompt」的要求——子会话是 fresh context，对这次
   * 对话一无所知。派发是异步的，文本回执明说「不会收到完成通知」，防父模型
   * 编造「子任务已完成」。
   */
  const startTask: ToolDefinition = {
    name: "start_task",
    label: "start_task",
    description:
      "Start a new task as a child of this task and hand it one instruction. " +
      "The child runs in the background in parallel, in this workspace and on this task's model by default; " +
      "you will NOT be notified when it finishes — never wait for it or report it as done. " +
      "The child starts with a fresh context and knows nothing about this conversation, so the prompt " +
      "must be fully self-contained: state the goal, the relevant file paths, constraints, and what " +
      '"done" looks like. Delegate a well-defined chunk of work — not a vague half-thought. ' +
      "Child tasks cannot start further tasks.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short label for the new task (shown in the task list), e.g. \"Fix login redirect\".",
        },
        prompt: {
          type: "string",
          description:
            "The full instruction for the child task. Self-contained: it is the only thing the child sees.",
        },
        model: {
          type: "string",
          description:
            "Optional model id to run the child on (cheaper models suit small chores). " +
            "Omit to use this task's model.",
        },
      },
      required: ["title", "prompt"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const modelRaw = args["model"];
      const model = typeof modelRaw === "string" && modelRaw.trim() !== "" ? modelRaw.trim() : undefined;
      const result = await broker.request<StartTaskOutcome>({
        type: "startTaskRequest",
        sessionId,
        title: String(args["title"] ?? ""),
        prompt: String(args["prompt"] ?? ""),
        ...(model === undefined ? {} : { model }),
      });
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: "text", text: result.text }],
        details: { startTask: result.card satisfies StartTaskCard },
      };
    },
  };

  return canDispatch ? [readTask, startTask] : [readTask];
}
