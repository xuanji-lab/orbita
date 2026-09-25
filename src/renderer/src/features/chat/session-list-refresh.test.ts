import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@shared/agent-ipc";
import type { SessionMeta } from "@shared/session";
import { shouldRefreshSessions } from "./session-list-refresh.ts";

/** 构造一条最小合法 SessionMeta：这里只有 id 与 parentId 有意义 */
const meta = (over: { id: string } & Partial<SessionMeta>): SessionMeta => ({
  title: `Task ${over.id}`,
  titleSource: "derived",
  cwd: "/tmp",
  workspaceId: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "manual",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const parent = meta({ id: "parent" });
const listed = [parent];

describe("shouldRefreshSessions", () => {
  test("列表里的会话一轮跑完（phase idle）：刷", () => {
    assert.equal(shouldRefreshSessions({ type: "phase", sessionId: "parent", phase: "idle" }, listed), true);
  });

  test("列表里的会话开轮 / 压缩：不刷——轮中途 meta 没变，跑完再刷", () => {
    assert.equal(shouldRefreshSessions({ type: "phase", sessionId: "parent", phase: "turn" }, listed), false);
    assert.equal(shouldRefreshSessions({ type: "phase", sessionId: "parent", phase: "compaction" }, listed), false);
  });

  // 这一条是这刀的由来：母会话还在跑时派出的子会话，首轮开跑的 phase 就是它
  // 第一次出现在 renderer 面前。不刷的话要等母会话这一轮跑完，Sub-sessions 入口才出现
  test("列表里没有的会话开轮（delegate 派出的子会话）：刷", () => {
    assert.equal(shouldRefreshSessions({ type: "phase", sessionId: "child", phase: "turn" }, listed), true);
  });

  test("刷回来之后，同一条子会话后续的开轮不再刷", () => {
    const refreshed = [parent, meta({ id: "child", parentId: "parent" })];
    assert.equal(shouldRefreshSessions({ type: "phase", sessionId: "child", phase: "turn" }, refreshed), false);
  });

  test("列表还没读回来（空）时来了 phase：刷——宁多拉一次，不漏", () => {
    assert.equal(shouldRefreshSessions({ type: "phase", sessionId: "parent", phase: "turn" }, []), true);
  });

  test("模型标题到了 / 会话内换了模型：刷（主进程已落 meta，不等 idle）", () => {
    assert.equal(shouldRefreshSessions({ type: "title", sessionId: "parent", title: "新标题" }, listed), true);
    assert.equal(
      shouldRefreshSessions({ type: "model", sessionId: "parent", providerId: "zai", modelId: "glm-5.3" }, listed),
      true,
    );
  });

  test("其余事件：不刷——列表里没有的会话只认 phase（每轮至多几次），不认流式帧那类高频事件", () => {
    const events: AgentEvent[] = [
      { type: "retry", sessionId: "child", status: null },
      { type: "created", sessionId: "child", piSessionFile: null },
      { type: "failed", sessionId: null, message: "runtime exited" },
    ];
    for (const event of events) assert.equal(shouldRefreshSessions(event, listed), false);
  });
});
