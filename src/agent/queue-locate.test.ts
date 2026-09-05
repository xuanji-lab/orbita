import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { locateQueued } from "./queue-locate.ts";

describe("locateQueued —— 下标只是提示，文本才算数", () => {
  test("下标命中：原样返回", () => {
    assert.equal(locateQueued(["甲", "乙", "丙"], 1, "乙"), 1);
  });

  test("下标过期（前面有条目被拿走）：按文本找回来", () => {
    // 真实事故：[甲,乙,丙] 里先发走乙，丙的下标从 2 变成 1，
    // UI 仍按旧快照传 2 —— 精确对账会落空，这里要能找回来
    assert.equal(locateQueued(["甲", "丙"], 2, "丙"), 1);
  });

  test("下标越界：按文本找回来", () => {
    assert.equal(locateQueued(["甲"], 9, "甲"), 0);
  });

  test("下标指到了别人身上：以文本为准，不切错人", () => {
    assert.equal(locateQueued(["甲", "乙"], 0, "乙"), 1);
  });

  test("那条真的已经被投递：返回 null，调用方放弃", () => {
    assert.equal(locateQueued(["甲", "丙"], 1, "乙"), null);
  });

  test("空队列：null", () => {
    assert.equal(locateQueued([], 0, "甲"), null);
  });

  test("重复文本且下标命中：认下标，不跳到第一条", () => {
    // 下标先行的价值就在这里：两条一模一样时仍按用户点的那条走
    assert.equal(locateQueued(["同样的话", "同样的话"], 1, "同样的话"), 1);
  });

  test("重复文本但下标过期：取第一条——内容一样，发哪条对用户无差别", () => {
    assert.equal(locateQueued(["同样的话", "同样的话"], 5, "同样的话"), 0);
  });
});
