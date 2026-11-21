import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMeta } from "@shared/session";
import { mainAgentEarlier } from "./main-progress.ts";

function meta(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    titleSource: "user",
    cwd: "/w",
    workspaceId: "ws",
    providerId: "p",
    modelId: "m",
    thinkingLevel: "high",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("mainAgentEarlier：进度面板里的以前的会话", () => {
  test("只列这个工作区里用户自己开的根会话，最近动过的在前", () => {
    const list = mainAgentEarlier(
      [
        meta("main", { role: "main", updatedAt: 9 }),
        meta("job", { parentId: "main", updatedAt: 8 }),
        meta("old", { updatedAt: 2 }),
        meta("newer", { updatedAt: 5 }),
        meta("other-ws", { workspaceId: "else", updatedAt: 7 }),
        meta("archived", { archived: true, updatedAt: 6 }),
        meta("auto-run", { automationId: "a", updatedAt: 4 }),
        meta("auto-promoted", { automationId: "a", promoted: true, updatedAt: 3 }),
      ],
      "ws",
    );
    assert.deepEqual(list.map((item) => item.id), ["newer", "auto-promoted", "old"]);
  });

  test("没有旧会话 = 空（整节不出）", () => {
    assert.deepEqual(mainAgentEarlier([meta("main", { role: "main" })], "ws"), []);
  });
});
