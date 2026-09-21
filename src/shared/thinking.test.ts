import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  isThinkingLevel,
  parseThinkingLevel,
  thinkingLevelLabel,
} from "./thinking.ts";

describe("parseThinkingLevel", () => {
  it("7 档（pi 全集）原样透传——档位词汇表不裁剪，菜单按模型真集显示", () => {
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

  it("真坏值退 medium（pi 认的 7 档之外才是坏值）", () => {
    assert.equal(parseThinkingLevel("ultra"), "medium");
    assert.equal(parseThinkingLevel("MED"), "medium");
  });
});

describe("isThinkingLevel", () => {
  it("守卫只回答是不是，不兜任何默认", () => {
    assert.equal(isThinkingLevel("off"), true);
    assert.equal(isThinkingLevel("high"), true);
    assert.equal(isThinkingLevel("xhigh"), true);
    assert.equal(isThinkingLevel(undefined), false);
    assert.equal(isThinkingLevel("medium "), false);
  });
});

describe("THINKING_LEVEL_LABELS", () => {
  it("显示名因模型家族而异：claude 的 xhigh 叫 Extra，其余档退通用名", () => {
    assert.equal(thinkingLevelLabel("xhigh", "claude-opus-5"), "Extra");
    assert.equal(thinkingLevelLabel("high", "claude-opus-5"), "High");
    assert.equal(thinkingLevelLabel("xhigh", "glm-5.3"), "Extra high");
    assert.equal(thinkingLevelLabel("xhigh", null), "Extra high");
  });

  it("7 档每档都有显示名；刻意没有描述——思考档不需要解释，宽度才能固定", () => {
    for (const level of THINKING_LEVELS) {
      assert.equal(typeof THINKING_LEVEL_LABELS[level].label, "string");
      assert.ok(THINKING_LEVEL_LABELS[level].label.length > 0);
      assert.equal("hint" in THINKING_LEVEL_LABELS[level], false);
    }
  });
});
