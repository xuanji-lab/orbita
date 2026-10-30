import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { scopeChipAction } from "./scope-chip.ts";

describe("scopeChipAction", () => {
  test("首页：不管在不在跑，选一项都是开新任务", () => {
    assert.equal(scopeChipAction({ inConversation: false, running: false, isCurrent: true }), "new-task");
    assert.equal(scopeChipAction({ inConversation: false, running: true, isCurrent: false }), "new-task");
  });

  test("对话里：选别的工作区 = 移过去；选当前所在 = 不动", () => {
    assert.equal(scopeChipAction({ inConversation: true, running: false, isCurrent: false }), "move");
    assert.equal(scopeChipAction({ inConversation: true, running: false, isCurrent: true }), "stay");
  });

  test("对话里且在跑：别的项灰掉，当前项仍是不动（不灰，打勾的那项不该看着像坏了）", () => {
    assert.equal(scopeChipAction({ inConversation: true, running: true, isCurrent: false }), "blocked");
    assert.equal(scopeChipAction({ inConversation: true, running: true, isCurrent: true }), "stay");
  });
});
