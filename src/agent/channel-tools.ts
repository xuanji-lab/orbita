import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import type { ChannelDelivery } from "../shared/channel.ts";
import type { ChannelSendOutcome, DelegateCard, DelegateOutcome, ModelCostsOutcome } from "../shared/agent-ipc.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../shared/thinking.ts";

/**
 * 子会话的三个通道工具（子会话 2026-09-23）：delegate / reply_subsession /
 * report_to_parent。照 task-tools.ts 的 requestBroker 范式——建会话 / 写账本
 * 都在主进程（agent 进程不碰 userData），这里只把参数翻成请求事件、把回执
 * 翻成工具结果。权限：三个工具在 shared/permission.ts 的 CHANNEL_TOOLS 三档
 * 全放行（协调而非动作）。
 *
 * `role` 决定注册哪些工具：
 * - "root"（普通会话，也是父）：delegate + reply_subsession + model_costs（派发前查价）。
 * - "child"：只有 report_to_parent——子会话不能再派出（主进程也会拒），
 *   子会话没有自己的子可回信。
 */
export function createChannelTools(
  broker: RequestBroker,
  sessionId: string,
  role: "root" | "child",
): ToolDefinition[] {
  if (role === "child") return [reportToParentTool(broker, sessionId)];
  return [delegateTool(broker, sessionId), replySubsessionTool(broker, sessionId), modelCostsTool(broker, sessionId)];
}

/** 必填字符串：trim 非空，否则抛带字段名的说明——不合法的参数不发请求。 */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const REPORT_KINDS = ["question", "progress", "done", "failed"] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

function isReportKind(value: unknown): value is ReportKind {
  return (REPORT_KINDS as readonly unknown[]).includes(value);
}

function isDelivery(value: unknown): value is ChannelDelivery {
  return value === "steer" || value === "followUp";
}

function delegateTool(broker: RequestBroker, sessionId: string): ToolDefinition {
  return {
    name: "delegate",
    label: "delegate",
    description:
      "Hand off a self-contained, parallelizable, well-bounded chunk of work to a new sub-session. " +
      "The sub-session gets its own context and workbench (same cwd as you). It cannot see this " +
      "conversation, so task must be self-contained: state what the user actually wants and why — quote " +
      "their own words where you can, and explain the reasoning behind any constraint — so the " +
      "sub-session can tell when it is drifting off course. Also state the goal, constraints, done " +
      "criteria, and where the output should go. After calling this, end your turn unless you have " +
      "unrelated work to do right now — do not poll or wait for it. The sub-session's question / " +
      'progress / done / failed reports arrive as <channel from="child" …> blocks in a later turn. If ' +
      "it asks something the user has not actually answered, do not guess on the user's behalf — end " +
      "this turn and ask the user first, then answer with reply_subsession once you know. Do not " +
      "delegate for small things. " +
      "Before delegating, call model_costs and choose the cheapest model and thinking tier that is good " +
      "enough for the job, then pass it as model / thinkingLevel: routine implementation to a spec, " +
      "running tests, research and data gathering rarely need a top-tier model; keep a mid tier at " +
      "medium thinking for design trade-offs; reserve the most expensive model with max thinking for " +
      "when the user names it or a cheaper tier has already failed. Project rules (AGENTS.md) that name " +
      "a model for a kind of work take precedence.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the sub-session; becomes its name.",
        },
        task: {
          type: "string",
          description:
            "Self-contained task description (the sub-session cannot see this conversation): the goal, " +
            "constraints, done criteria, and where the output should go.",
        },
        model: {
          type: "string",
          description:
            "Optional model id override, as listed by model_costs. Defaults to the sub-session model setting, " +
            "then this session's model.",
        },
        thinkingLevel: {
          type: "string",
          enum: [...THINKING_LEVELS],
          description: "Optional thinking level override for the sub-session.",
        },
      },
      required: ["title", "task"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const title = requireNonEmptyString(args["title"], "title");
      const task = requireNonEmptyString(args["task"], "task");
      const model = optionalNonEmptyString(args["model"]);
      const thinkingRaw = args["thinkingLevel"];
      let thinkingLevel: ThinkingLevel | undefined;
      if (thinkingRaw !== undefined) {
        if (!isThinkingLevel(thinkingRaw)) {
          throw new Error(`"thinkingLevel" is not a valid thinking level: ${JSON.stringify(thinkingRaw)}`);
        }
        thinkingLevel = thinkingRaw;
      }
      const result = await broker.request<DelegateOutcome>({
        type: "delegateRequest",
        sessionId,
        title,
        task,
        ...(model === undefined ? {} : { modelId: model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      });
      if (!result.ok) throw new Error(result.error);
      const card = result.card;
      const text =
        `Sub-session "${result.title}" (id ${result.childId}) started, running on ${card.modelId} ` +
        `(thinking: ${card.thinkingLevel}). Its private scratch workbench is ${card.workbench}. It is now working; its messages will arrive as <channel> ` +
        "blocks in a later turn. Unless you have unrelated work to do right now, end this turn — do " +
        "not poll or wait for it.";
      return {
        content: [{ type: "text", text }],
        details: { delegate: card satisfies DelegateCard },
      };
    },
  };
}

/**
 * model_costs：派发前的价格 · 能力参考（用户 2026-10-30：「我们的帕累托数据，我希望能作为主会话派发
 * 子会话前的参考数据」）。数据在主进程（任务账本、服务商声明），与设置页「价格 · 能力图」同一份——
 * 表由主进程压好（main/usage/model-costs.ts），这里只发请求、原样回文本。
 *
 * 不把表放进系统提示词：账本每天都在变，放进去每轮都会打断提示缓存；工具结果是按需取的，
 * 只在派发前花一次上下文。只根会话注册（子会话不能再派，不需要它）。
 */
function modelCostsTool(broker: RequestBroker, sessionId: string): ToolDefinition {
  return {
    name: "model_costs",
    label: "model_costs",
    description:
      "Look up what each model the user has added costs per task and how it scores on the Arena " +
      "leaderboard (per category, with the Pareto frontier marked). Read-only, no arguments. Call it " +
      "before delegate to pick the cheapest model and thinking tier that is good enough for the job. " +
      "Costs are the user's own measured median per finished task (or an estimate when there are fewer " +
      "than 3 samples). Each row gives the exact model and thinking values to pass to delegate.",
    promptSnippet:
      "Per-task cost and Arena scores of the user's added models (Pareto frontier marked): check before choosing a model for delegate",
    parameters: { type: "object", properties: {}, required: [] } as never,
    async execute() {
      const result = await broker.request<ModelCostsOutcome>({ type: "modelCostsRequest", sessionId });
      if (!result.ok) throw new Error(result.error);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  };
}

function replySubsessionTool(broker: RequestBroker, sessionId: string): ToolDefinition {
  return {
    name: "reply_subsession",
    label: "reply_subsession",
    description:
      "Reply to a sub-session you delegated to — use this to answer a question it asked, or to steer " +
      "it. Text in your normal reply is never delivered to the sub-session; only this tool reaches it. " +
      "delivery \"steer\" (default): injects at the sub-session's next tool-call boundary without ending " +
      "its current turn. \"followUp\": waits until its turn would otherwise end, then delivers. Both " +
      "start a new turn immediately if the sub-session is idle.",
    parameters: {
      type: "object",
      properties: {
        childId: {
          type: "string",
          description: "The sub-session's id (from the delegate result or a channel block).",
        },
        text: { type: "string", description: "The reply text." },
        delivery: {
          type: "string",
          enum: ["steer", "followUp"],
          description:
            "steer (default) injects without ending the sub-session's current turn; followUp waits for " +
            "its turn to end first. Idle sub-sessions start a new turn immediately either way.",
        },
      },
      required: ["childId", "text"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const childId = requireNonEmptyString(args["childId"], "childId");
      const text = requireNonEmptyString(args["text"], "text");
      const deliveryRaw = args["delivery"];
      let delivery: ChannelDelivery | undefined;
      if (deliveryRaw !== undefined) {
        if (!isDelivery(deliveryRaw)) {
          throw new Error(`"delivery" must be "steer" or "followUp", got ${JSON.stringify(deliveryRaw)}`);
        }
        delivery = deliveryRaw;
      }
      const result = await broker.request<ChannelSendOutcome>({
        type: "channelSendRequest",
        sessionId,
        to: { childId },
        kind: "reply",
        text,
        ...(delivery === undefined ? {} : { delivery }),
      });
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: "text", text: "Reply sent to the sub-session." }],
        // 落账那条通道消息的 id：renderer 的发送侧标记凭它点了能定位到这一条
        // （tool-results.ts 的 channelSendMessageId）；给模型看的正文不带
        details: { messageId: result.messageId },
      };
    },
  };
}

function reportToParentTool(broker: RequestBroker, sessionId: string): ToolDefinition {
  return {
    name: "report_to_parent",
    label: "report_to_parent",
    description:
      "Report to the parent session that delegated this task to you. This is the only way it hears " +
      "from you — a normal reply is never delivered to it. kind \"question\": you are blocked and need a " +
      "decision; proceed on your best guess while you wait, or end this turn if you truly cannot " +
      'continue. "progress": occasional update, use sparingly. "done": you finished — say what you ' +
      'concluded, what you changed, and where the output is, then end this turn. Include absolute paths ' +
      'to important output (especially for done). "failed": you cannot ' +
      "complete the task — say why, then end this turn.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...REPORT_KINDS],
          description: "question | progress | done | failed.",
        },
        text: { type: "string", description: "The report text." },
      },
      required: ["kind", "text"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const kindRaw = args["kind"];
      if (!isReportKind(kindRaw)) {
        throw new Error(
          `"kind" must be one of ${REPORT_KINDS.join(", ")}, got ${JSON.stringify(kindRaw)}`,
        );
      }
      const text = requireNonEmptyString(args["text"], "text");
      const result = await broker.request<ChannelSendOutcome>({
        type: "channelSendRequest",
        sessionId,
        to: "parent",
        kind: kindRaw,
        text,
      });
      if (!result.ok) throw new Error(result.error);
      const suffix = kindRaw === "done" || kindRaw === "failed" ? " Task handed back — end this turn." : "";
      return {
        content: [{ type: "text", text: `Reported to parent.${suffix}` }],
        // 同 reply_subsession：子会话工作记录里的标记凭它定位到父子会话面板里的这一条
        details: { messageId: result.messageId },
      };
    },
  };
}

/**
 * 通道角色的使用说明（拼进 system prompt，同 STORE_TOOLS_GUIDELINES 的注入方式）。
 * 工具参数 schema 已经讲了字段；这里讲角色语境——root 是能派出子会话的普通会话，
 * child 是被派出的那一个，两者看到的通道是不对称的（root 用 delegate /
 * reply_subsession，child 只有 report_to_parent），所以说明也分两段。
 * 与 related（describeDirectories）的关系：related 只用于 runtime 判断角色；对方工作台由
 * delegate 回执与通道信封携带。这里讲「怎么用工具跟对面说话、重要产出放哪」，两段都不随
 * 会话中的父子清单变化，因此可以安全留在系统提示词里。
 */
const ROOT_CHANNEL_GUIDELINES = `<orbita-sub-sessions>
You can hand off self-contained, parallelizable, well-bounded work to a sub-session with delegate. It
runs with its own context and workbench (same cwd as you). Because it cannot see this conversation, the
task must state what the user actually wants and why — quote their own words where you can, and explain
the reasoning behind any constraint, so the sub-session can judge when it is drifting off course — plus
the goal, constraints, done criteria, and where the output should go. After delegating, end this turn
unless you have unrelated work to do — do not poll or wait for it. Its messages (question / progress /
done / failed) arrive as <channel from="child" …> blocks in a later turn. If it asks something the
user's own words do not answer, do not decide on the user's behalf — end this turn and ask the user
first; only once you have their answer, reply with reply_subsession. Progress needs no reply. Important
sub-session output belongs in subsessions/ under your own Session workbench, in the sub-session's own
subdirectory. When you see done, check that directory for the actual output (and cwd for requested code
or repository changes) before reporting to the user. Do not delegate for small things.
</orbita-sub-sessions>`;

const CHILD_CHANNEL_GUIDELINES = `<orbita-sub-sessions>
You are a sub-session delegated by a parent session. Your task is in the first
<channel from="parent" kind="task"> block. Your normal replies are not visible to the parent — only
report_to_parent is delivered. If the task is unclear, or looks like it may conflict with what the user
actually wants, send a question early — before you sink real work into a guess — stating what is
unclear and what you would default to; do not ask about things that are already obvious just to look
proactive. Otherwise proceed on your best guess while you wait for a reply (or end this turn if you
truly cannot continue without one). You may send occasional progress updates — sparingly, only when
useful. When you finish, you MUST send one done report with your conclusion, what you changed, and where
the output is. If you cannot complete the task, send failed with the reason. The parent's replies arrive
as <channel from="parent" kind="reply"> blocks, possibly mid-task — adjust accordingly.
Keep plans, drafts, intermediate results and reproduction scripts in your own Session workbench. Write
important output for the parent (reports, handoffs, evaluation results, screenshot evidence and similar)
under the parent session workbench in subsessions/<your-short-id>-<short-english-name>/; use the first
8 characters of your own session id (the last component of your Session workbench path) so concurrent
sub-sessions do not collide. In report_to_parent, especially done, give the absolute paths of those
files. Requested code and repository deliverables still belong in cwd and are unaffected by this rule.
</orbita-sub-sessions>`;

/** 按角色选一段通道使用说明；root/child 各自固定，不随 related 内容变化。 */
export function describeChannelRole(role: "root" | "child"): string {
  return role === "root" ? ROOT_CHANNEL_GUIDELINES : CHILD_CHANNEL_GUIDELINES;
}
