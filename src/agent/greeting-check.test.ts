import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { greetingPrompt, parseGreetingReply } from "./greeting-check.ts";

describe("greeting-check", () => {
  test("正文：编号 + JSON 转义的原文，换行与引号不串行", () => {
    assert.equal(greetingPrompt(["hi", 'say "x"\nnow']), '0: "hi"\n1: "say \\"x\\"\\nnow"');
  });

  test("回复：取第一个 JSON 数组，容忍说明文字与代码块；越界、重复、非整数丢掉；读不懂返回 null", () => {
    assert.deepEqual(parseGreetingReply("[0, 3]", 4), [0, 3]);
    assert.deepEqual(parseGreetingReply("```json\n[2,2, 1]\n```", 3), [1, 2]);
    assert.deepEqual(parseGreetingReply("These are throwaway: [1, 7]", 3), [1]);
    assert.deepEqual(parseGreetingReply("[]", 3), []);
    assert.equal(parseGreetingReply("none of them", 3), null);
    assert.equal(parseGreetingReply('["a"]', 3), null);
  });
});
