import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  isThinkingLevel,
  parseThinkingLevel,
} from "./thinking.ts";

describe("parseThinkingLevel", () => {
  it("5 档原样透传", () => {
    for (const level of THINKING_LEVELS) {
      assert.equal(parseThinkingLevel(level), level);
    }
  });

  it("坏值退 medium——存量会话实际跑的就是这一档，退 off 才是改写历史", () => {
    assert.equal(parseThinkingLevel(undefined), "medium");
    assert.equal(parseThinkingLevel("yolo"), "medium");
    assert.equal(parseThinkingLevel(42), "medium");
    assert.equal(parseThinkingLevel(null), "medium");
  });

  it("xhigh / max 是 pi 的档、不是我们的：按坏值退 medium（首刀没放出它们）", () => {
    assert.equal(parseThinkingLevel("xhigh"), "medium");
    assert.equal(parseThinkingLevel("max"), "medium");
  });
});

describe("isThinkingLevel", () => {
  it("守卫只回答是不是，不兜任何默认", () => {
    assert.equal(isThinkingLevel("off"), true);
    assert.equal(isThinkingLevel("high"), true);
    assert.equal(isThinkingLevel("xhigh"), false);
    assert.equal(isThinkingLevel(undefined), false);
    assert.equal(isThinkingLevel("medium "), false);
  });
});

describe("THINKING_LEVEL_LABELS", () => {
  it("5 档每档都有 label 与 hint（芯片与菜单都读它）", () => {
    for (const level of THINKING_LEVELS) {
      const entry = THINKING_LEVEL_LABELS[level];
      assert.equal(typeof entry.label, "string");
      assert.ok(entry.label.length > 0);
      assert.equal(typeof entry.hint, "string");
      assert.ok(entry.hint.length > 0);
    }
  });
});
