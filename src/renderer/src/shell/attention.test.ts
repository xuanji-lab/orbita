import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMeta } from "../../../shared/session.ts";
import type { SessionRunState } from "../features/notify/completion-notice.ts";
import { attentionItems, freshAttention } from "./attention.ts";

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    titleSource: "user",
    cwd: "/w",
    workspaceId: "w",
    providerId: "p",
    modelId: "m",
    thinkingLevel: "medium",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe("侧栏顶上的「等你」", () => {
  const states: Record<string, SessionRunState> = { ask1: "waiting", ask2: "waiting", bad: "failed", run: "running", done: "done" };
  const stateOf = (m: SessionMeta): SessionRunState => states[m.id] ?? null;

  test("跨工作区只挑在问的与没做成的；在问的在前，同档最近动过的在前", () => {
    const items = attentionItems(
      [
        { workspaceId: "a", rows: [meta("bad", { updatedAt: 9 }), meta("run"), meta("ask1", { updatedAt: 1 })] },
        { workspaceId: "b", rows: [meta("ask2", { updatedAt: 5 }), meta("done")] },
        { workspaceId: null, rows: [] },
      ],
      stateOf,
    );
    assert.deepEqual(
      items.map((item) => [item.meta.id, item.workspaceId]),
      [["ask2", "b"], ["ask1", "a"], ["bad", "a"]],
    );
  });

  test("提示音只为新冒出来的那件响：响过的不再响", () => {
    assert.deepEqual(freshAttention(["a", "b"], new Set(["a"])), ["b"]);
    assert.deepEqual(freshAttention(["a"], new Set(["a", "b"])), []);
  });

  test("没做成的那件被主智能体处理过（回了话 / 暂停 / 放弃 / 重派）就不在「等你」里", () => {
    const rows = [meta("bad", { parentId: "main" }), meta("ask1", { parentId: "main" })];
    const items = attentionItems([{ workspaceId: "a", rows }], stateOf, (m) => m.id === "bad");
    assert.deepEqual(items.map((item) => item.meta.id), ["ask1"]);
  });
});
