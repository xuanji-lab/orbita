import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SUB_SESSIONS_LIST,
  escapeFrom,
  openSubSession,
  syncToMainSession,
  type SubSessionsView,
} from "./sub-sessions-state.ts";

describe("openSubSession", () => {
  it("进会话层，带上点的那条 id", () => {
    deepStrictEqual(openSubSession("child-1"), { kind: "session", sessionId: "child-1" });
  });
});

describe("syncToMainSession", () => {
  it("主槽 id 不变：原样返回（不丢用户在面板里的位置）", () => {
    const view: SubSessionsView = { kind: "session", sessionId: "child-1" };
    strictEqual(syncToMainSession(view, "root-1", "root-1"), view);
  });

  it("主槽 id 变了：一律回列表，即便当前已经是列表层", () => {
    const session: SubSessionsView = { kind: "session", sessionId: "child-1" };
    deepStrictEqual(syncToMainSession(session, "root-1", "root-2"), SUB_SESSIONS_LIST);
    deepStrictEqual(syncToMainSession(SUB_SESSIONS_LIST, "root-1", "root-2"), SUB_SESSIONS_LIST);
  });

  it("null ⇄ null（都没在看根会话/都在首页）不算变化", () => {
    const view: SubSessionsView = { kind: "session", sessionId: "child-1" };
    strictEqual(syncToMainSession(view, null, null), view);
  });

  it("从 null 换成一个真 id 算变化：回列表", () => {
    const view: SubSessionsView = { kind: "session", sessionId: "child-1" };
    deepStrictEqual(syncToMainSession(view, null, "root-1"), SUB_SESSIONS_LIST);
  });
});

describe("escapeFrom", () => {
  it("会话层：退回列表", () => {
    deepStrictEqual(escapeFrom({ kind: "session", sessionId: "child-1" }), SUB_SESSIONS_LIST);
  });

  it("列表层：交给调用方关面板（null）", () => {
    strictEqual(escapeFrom(SUB_SESSIONS_LIST), null);
  });
});
