/**
 * 纯聊天的活（能力集 ["none"]，shared/capabilities.ts）交回结果：它没有任何工具，连 report_to_parent 也没有，
 * 所以由主进程把它这一轮的最终回答当「完成」投回派它的人（出错就当「没做成」）。
 * 选这条路而不是给它留一个 report_to_parent：留一个工具就得留工具说明与通道说明，纯聊天的提示就不纯了；
 * 而且模型忘了调它，结果就静默丢了——这里不靠模型记得。
 *
 * 只旁听 agent 事件（与自动化调度同一个位置），不改事件流。被停掉 / 暂停的那一轮（aborted）不交：那不是它的答案。
 * 纯核 + 注入：不 import electron，node --test 直接测。
 */
import type { AgentEvent, ChannelSendOutcome } from "../../shared/agent-ipc.ts";
import { isChatOnly } from "../../shared/capabilities.ts";
import type { SessionMeta } from "../../shared/session.ts";

type ChannelSendRequest = Extract<AgentEvent, { type: "channelSendRequest" }>;

export interface ChatHandbackDeps {
  readMeta(sessionId: string): Promise<SessionMeta | null>;
  /** 与 report_to_parent 同一条落账路（applyChannelSend） */
  send(event: ChannelSendRequest): Promise<ChannelSendOutcome>;
}

interface LastAnswer {
  status: "complete" | "aborted" | "error";
  text: string;
  error: string | null;
}

export class ChatHandback {
  private readonly deps: ChatHandbackDeps;
  /** 每条会话这一轮最后一条回答（idle 时取走即删，不常驻） */
  private readonly last = new Map<string, LastAnswer>();

  constructor(deps: ChatHandbackDeps) {
    this.deps = deps;
  }

  /** 收一条 agent 事件；idle 时若是纯聊天的活就交回。返回交回的那一步（测试等它） */
  onAgentEvent(event: AgentEvent): Promise<void> | undefined {
    if (event.type === "progress") {
      if (event.progress.type !== "item_finished") return undefined;
      const item = event.progress.item;
      if (item.role !== "assistant") return undefined;
      const text = item.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      this.last.set(event.sessionId, {
        status: item.status === "complete" ? "complete" : item.status === "aborted" ? "aborted" : "error",
        text,
        error: item.status === "error" ? (item.errorMessage ?? null) : null,
      });
      return undefined;
    }
    if (event.type !== "phase" || event.phase !== "idle") return undefined;
    const answer = this.last.get(event.sessionId);
    this.last.delete(event.sessionId);
    if (answer === undefined || answer.status === "aborted") return undefined;
    return this.handBack(event.sessionId, answer).catch((cause: unknown) => {
      console.error("[main] 纯聊天的活交回结果失败", cause);
    });
  }

  private async handBack(sessionId: string, answer: LastAnswer): Promise<void> {
    const meta = await this.deps.readMeta(sessionId);
    if (meta === null || meta.parentId === undefined || !isChatOnly(meta.capabilities)) return;
    const failed = answer.status === "error" || answer.text === "";
    const text = failed ? (answer.error ?? (answer.text !== "" ? answer.text : "The chat-only sub-session ended without an answer.")) : answer.text;
    const outcome = await this.deps.send({
      type: "channelSendRequest",
      requestId: "",
      sessionId,
      to: "parent",
      kind: failed ? "failed" : "done",
      text,
    });
    if (!outcome.ok) console.error(`[main] 纯聊天的活 ${sessionId} 交回被拒：${outcome.error}`);
  }
}
