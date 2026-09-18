import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import type { ReadTaskCard, ReadTaskOutcome } from "../shared/agent-ipc.ts";

/**
 * agent 的「跨 task 只读」工具（B-1）：read_task。
 *
 * 读盘在主进程（agent 进程不碰 userData）——requestId 问答，见 ./request-broker.ts。
 * 只读：decidePermission 把它收进 READ_ONLY_TOOLS（plan 放行 / manual 问 / skip 放）。
 * 结果的 text 进模型上下文；card 挂 `details`——details 的明文语义是「只给 UI、
 * 不入模型上下文」（edit 的 diff 是先例），renderer 的任务卡与跳转吃它。
 */
export function createTaskTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
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
  return [readTask];
}
