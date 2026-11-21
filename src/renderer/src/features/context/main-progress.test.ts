import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMeta } from "@shared/session";
import { foldToggle, mainAgentEarlier, splitWaiting } from "./main-progress.ts";

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

describe("等你的折叠", () => {
  test("多于三件：先露三件，其余折起", () => {
    assert.deepEqual(splitWaiting([1, 2, 3, 4, 5]), { rows: [1, 2, 3], folded: [4, 5] });
  });

  test("边界：恰好三件与更少时没有折叠行", () => {
    assert.deepEqual(splitWaiting([1, 2, 3]).folded, []);
    assert.deepEqual(splitWaiting([]), { rows: [], folded: [] });
  });

  test("展开后不再写「还有 N 件等你」，改写收起、箭头朝上", () => {
    assert.deepEqual(foldToggle(false, "还有 2 件等你", "收起"), { label: "还有 2 件等你", icon: "chevron-right" });
    assert.deepEqual(foldToggle(true, "还有 2 件等你", "收起"), { label: "收起", icon: "chevron-up" });
  });

  test("没有展开态文案的组名（做完 N 件）两态同一句，展开时箭头朝下", () => {
    assert.deepEqual(foldToggle(true, "做完 3 件", undefined), { label: "做完 3 件", icon: "chevron-down" });
  });
});
