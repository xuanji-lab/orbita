import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { ChatHandback } from "./chat-handback.ts";

type Send = Extract<AgentEvent, { type: "channelSendRequest" }>;

function meta(id: string, patch: Partial<SessionMeta>): SessionMeta {
  return { id, title: "t", titleSource: "user", cwd: "/x", workspaceId: null, providerId: "p", modelId: "m", thinkingLevel: "off", piSessionFile: null, pinned: false, archived: false, recentQueries: [], stats: null, createdAt: 1, updatedAt: 1, ...patch } as SessionMeta;
}

function answer(sessionId: string, status: "complete" | "aborted" | "error", text: string, errorMessage?: string): AgentEvent {
  return {
    type: "progress",
    sessionId,
    progress: { type: "item_finished", item: { id: "a", role: "assistant", status, content: text === "" ? [] : [{ type: "text", text }], ...(errorMessage === undefined ? {} : { errorMessage }) } },
  } as unknown as AgentEvent;
}
const idle = (sessionId: string): AgentEvent => ({ type: "phase", sessionId, phase: "idle" }) as AgentEvent;

function setup(metas: SessionMeta[]): { handback: ChatHandback; sent: Send[] } {
  const sent: Send[] = [];
  const handback = new ChatHandback({
    readMeta: async (id) => metas.find((each) => each.id === id) ?? null,
    send: async (event) => {
      sent.push(event);
      return { ok: true, messageId: "m" };
    },
  });
  return { handback, sent };
}

describe("纯聊天的活交回结果", () => {
  test("这一轮停下时，最后一条回答当 done 投回父", async () => {
    const { handback, sent } = setup([meta("c", { parentId: "p", capabilities: ["none"] })]);
    handback.onAgentEvent(answer("c", "complete", "先想了一半"));
    handback.onAgentEvent(answer("c", "complete", "结论：选 B。"));
    await handback.onAgentEvent(idle("c"));
    assert.deepEqual(sent.map((event) => [event.sessionId, event.to, event.kind, event.text]), [["c", "parent", "done", "结论：选 B。"]]);
  });
  test("出错当 failed（带错误原因）；被停掉的那一轮不交", async () => {
    const { handback, sent } = setup([meta("c", { parentId: "p", capabilities: ["none"] })]);
    handback.onAgentEvent(answer("c", "error", "", "429 rate limited"));
    await handback.onAgentEvent(idle("c"));
    handback.onAgentEvent(answer("c", "aborted", "说到一半"));
    assert.equal(handback.onAgentEvent(idle("c")), undefined);
    assert.deepEqual(sent.map((event) => [event.kind, event.text]), [["failed", "429 rate limited"]]);
  });
  test("不是纯聊天的活、根会话、全带的活：一概不碰", async () => {
    const { handback, sent } = setup([meta("a", { parentId: "p", capabilities: [] }), meta("b", { parentId: "p" }), meta("r", { capabilities: ["none"] })]);
    for (const id of ["a", "b", "r"]) {
      handback.onAgentEvent(answer(id, "complete", "答"));
      await handback.onAgentEvent(idle(id));
    }
    assert.equal(sent.length, 0);
  });
});
