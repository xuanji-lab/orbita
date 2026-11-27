import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { StartupClosureQueue } from "./startup-closures.ts";
import type { ChannelClosureNotice } from "./reconcile.ts";

const notice = (parentId: string, childId: string): ChannelClosureNotice =>
  ({ parentId, childId, message: { id: childId }, status: "done", childWorkbench: "/w" }) as unknown as ChannelClosureNotice;

describe("启动收尾通知：后台跑完与父会话第一次 list 谁先到都只播一次", () => {
  test("收尾先完成：父会话 list 时补播它自己的，别的不动", () => {
    const sent: string[] = [];
    const queue = new StartupClosureQueue((list) => sent.push(...list.map((n) => n.childId)));
    queue.resolve([notice("P", "a"), notice("Q", "b")]);
    assert.deepEqual(sent, []);
    queue.listed("P");
    assert.deepEqual(sent, ["a"]);
    queue.listed("P");
    assert.deepEqual(sent, ["a"], "再 list 不重播");
    queue.listed("Q");
    assert.deepEqual(sent, ["a", "b"]);
  });

  test("父会话先 list：收尾完成那一刻直接播给它，之后 list 不重播", () => {
    const sent: string[] = [];
    const queue = new StartupClosureQueue((list) => sent.push(...list.map((n) => n.childId)));
    queue.listed("P");
    assert.deepEqual(sent, []);
    queue.resolve([notice("P", "a"), notice("Q", "b")]);
    assert.deepEqual(sent, ["a"]);
    queue.listed("P");
    assert.deepEqual(sent, ["a"]);
    queue.listed("Q");
    assert.deepEqual(sent, ["a", "b"]);
  });

  test("收尾失败（空列表）不播任何东西", () => {
    const sent: string[] = [];
    const queue = new StartupClosureQueue((list) => sent.push(...list.map((n) => n.childId)));
    queue.listed("P");
    queue.resolve([]);
    queue.listed("P");
    assert.deepEqual(sent, []);
  });
});
