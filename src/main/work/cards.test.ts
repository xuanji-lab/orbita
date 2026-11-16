import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { workCardsFor } from "./cards.ts";
import type { SessionDetail, SessionMeta } from "../../shared/session.ts";
import type { ChannelMessage } from "../../shared/channel.ts";

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, title: id, titleSource: "user", cwd: "/", workspaceId: "w", providerId: "p", modelId: "m", thinkingLevel: "medium", piSessionFile: null, pinned: false, archived: false, recentQueries: [], stats: null, createdAt: 1, updatedAt: 1, ...extra }) as SessionMeta;

describe("workCardsFor —— 只读它自己派出的活，按小卡说，不给原文", () => {
  test("只列这个父的子会话；状态取通道账本、动静取事件泵记的时刻", async () => {
    const list = [meta("main", { role: "main" }), meta("a", { parentId: "main", title: "跑基线" }), meta("x", { parentId: "other" })];
    const question: ChannelMessage = { id: "q", from: "child", author: "model", kind: "question", text: "要不要算进对比？", delivery: "followUp", createdAt: 1 };
    const text = await workCardsFor(
      {
        sessions: { list: async () => list, load: async (id: string) => ({ meta: list.find((m) => m.id === id)!, transcript: [] }) as unknown as SessionDetail },
        channels: { load: async () => [question] },
        running: () => false,
        lastActivityAt: () => null,
      },
      "main",
      0,
    );
    assert.equal(text.split("\n").length, 1);
    assert.ok(text.includes("「跑基线」") && text.includes("在等它问的那个问题的回答") && text.includes("要不要算进对比？"));
    assert.ok(!text.includes("「x」"));
  });
});
