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

/**
 * App 里那个 effect 的时序模型：setState 的 updater 不保证在派发时就执行——
 * 同 fiber 已有待处理更新时（子会话在跑，引擎的 applyStates/refreshSessions
 * 更新不断，正是切换主会话时的常态），React 把 updater 推迟到渲染期才调用。
 * 「切主会话右栏不跟着切」的根因就是旧接线把「读上一拍主 id」留在 updater 里
 * 惰性做：渲染期 ref 已被写成新 id，两个参数恒相等，重置被静默吞掉。
 * 这组用例钉住契约：两个 id 必须在派发前捕获（链进局部量），updater 被推迟
 * 到渲染期执行也照样重置。
 */
describe("syncToMainSession 的调用时序（App effect 接线契约）", () => {
  /** 模拟 App 的 effect：先读 ref、派发 updater、写回 ref，再在「渲染期」执行 updater */
  function dispatchAndRender(
    view: SubSessionsView,
    ref: { current: string | null },
    nextMainId: string | null,
    wiring: "capture-before-write" | "lazy-ref-in-updater",
  ): SubSessionsView {
    // setState 只入队：捕获的是局部量（修复后）还是「到执行时才读 ref」（旧接线）
    const previousCaptured = wiring === "capture-before-write" ? ref.current : null;
    const queued = (prev: SubSessionsView): SubSessionsView =>
      syncToMainSession(prev, wiring === "capture-before-write" ? previousCaptured : ref.current, nextMainId);
    ref.current = nextMainId; // effect 本体里紧跟的那行写回——updater 还没执行
    return queued(view); // 渲染期：React 这时才调用 updater
  }

  it("正常路径：id 派发前捕获，updater 推迟到渲染期也回列表", () => {
    const ref = { current: "root-1" };
    deepStrictEqual(
      dispatchAndRender({ kind: "session", sessionId: "child-1" }, ref, "root-2", "capture-before-write"),
      SUB_SESSIONS_LIST,
    );
  });

  it("边界：主 id 没变（无关重渲染），推迟执行也不丢面板里的位置", () => {
    const ref = { current: "root-1" };
    const view: SubSessionsView = { kind: "session", sessionId: "child-1" };
    strictEqual(dispatchAndRender(view, ref, "root-1", "capture-before-write"), view);
  });

  it("旧接线（updater 惰性读 ref）在推迟执行时重置被吞：这正是要防住的回归", () => {
    const ref = { current: "root-1" };
    const swallowed: SubSessionsView = { kind: "session", sessionId: "child-1" };
    // 渲染期 ref 已是 root-2：两个 id 相等 → 原样返回，右栏继续挂着上一条母会话的子会话
    strictEqual(dispatchAndRender(swallowed, ref, "root-2", "lazy-ref-in-updater"), swallowed);
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
