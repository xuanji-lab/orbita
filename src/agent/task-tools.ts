import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import type { ReadTaskCard, ReadTaskOutcome } from "../shared/agent-ipc.ts";

/**
 * agent 的「跨 task 只读」工具（B-1）：read_task。
 *
 * 读盘在主进程（agent 进程不碰 userData）——requestId 问答，见 ./request-broker.ts。
 * 权限：decidePermission 把它收进 READ_ONLY_TOOLS——三档里与 read/grep 同待遇
 * （plan 放行 / manual 问 / skip 放）。plan 档弹审批的政策立过又撤了
 * （2026-09-18 二次裁决：读取而已），史见 shared/permission.ts 的 READ_ONLY_TOOLS 注释。
 * 结果的 text 进模型上下文；card 挂 `details`——details 的明文语义是「只给 UI、
 * 不入模型上下文」（edit 的 diff 是先例），renderer 的任务卡与跳转吃它。
 */
export function createTaskTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
  const readTask: ToolDefinition = {
    name: "read_task",
    label: "read_task",
    description:
      "Read another task's transcript (read-only). " +
      'Call with no arguments first to list the tasks in the current workspace — the user\'s "other" or ' +
      '"previous" tasks almost always means these. ' +
      'Then call again with "task" set to an exact title or id to read one: you get the header, ' +
      "a table of contents (one line per round) and the most recent rounds in full. " +
      'To read specific older rounds, add "rounds" using the numbers from the contents, e.g. "3", "2-5" or "1,4". ' +
      "If the task is a sub-session (delegated with delegate), the overview gives only its status and its reports " +
      "to its parent, not the process — reading the process back would spend the context the sub-session exists " +
      'to save. It names the record file; read that, or use "rounds", only if you really need the process. ' +
      "Prefix matching is scoped to the current workspace.",
    // promptSnippet 缺席时 pi 不把工具列进系统提示的 Available tools（system-prompt.ts 的
    // visibleTools 只认带 snippet 的）——read_task 原先就这样只活在工具 schema 里，
    // 模型查完 RAG / 记忆库 / chats 搜索就以为看过聊天记录了（2026-10-23 用户：「read task
    // 完全没有意识到可以调用」）。guidelines 讲清两件事：别的任务的原文只有它读得到；
    // 消息里的 <referenced_task> 是用户拖进来的指针（shared/task-ref.ts），该读就读
    promptSnippet:
      "Read the transcript of another task (conversation) in this app: the only way to see what was actually said there",
    promptGuidelines: [
      "When the user refers to another task or an earlier conversation in this app (\"the other task\", \"what we discussed before\", \"the sub-session\", a task title or id), read it with read_task before answering. " +
        "Memory notes, RAG / knowledge-base search and saved chat exports (for example a search with source \"chats\") are summaries or separate corpora: they do not show this app's task transcripts, so a hit there does not mean you have read the conversation.",
      'A user message may begin with <referenced_task id="…" title="…" /> lines: tasks the user dragged into the message. ' +
        "Call read_task with that exact id to read each one you need (the overview first, then specific rounds) instead of guessing what it contains.",
    ],
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Which task to read: its id, its exact title, or a unique prefix of either. " +
            "Omit to list the tasks in the current workspace instead.",
        },
        rounds: {
          type: "string",
          description: 'Round numbers from the contents, e.g. "3", "2-5", "1,4". Omit for the overview.',
        },
      },
      required: [],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const roundsRaw = args["rounds"];
      const rounds = typeof roundsRaw === "string" && roundsRaw.trim() !== "" ? roundsRaw : undefined;
      const taskRaw = args["task"];
      // task 缺席 / 空白 = 目录模式：不带该字段，主进程列当前工作区的兄弟 task
      const task = typeof taskRaw === "string" && taskRaw.trim() !== "" ? taskRaw : undefined;
      const result = await broker.request<ReadTaskOutcome>({
        type: "readTaskRequest",
        sessionId,
        ...(task === undefined ? {} : { task }),
        ...(rounds === undefined ? {} : { rounds }),
      });
      if (!result.ok) throw new Error(result.error);
      const card: ReadTaskCard | null = result.card;
      return {
        content: [{ type: "text", text: result.text }],
        // 目录模式没有「某一条」可跳：不挂 readTask（details 本身是 pi 的必填字段），
        // renderer 的 readTaskCard 校验缺 sessionId 就判 null，没有卡也就不画卡
        details: card === null ? {} : { readTask: card satisfies ReadTaskCard },
      };
    },
  };
  return [readTask];
}
