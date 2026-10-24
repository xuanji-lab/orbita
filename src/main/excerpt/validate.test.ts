/**
 * 摘抄 IPC 入参校验的测试。跑法：`node --test src/main/excerpt/validate.test.ts`。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseExcerptAddRequest, parseExcerptRemoveRequest } from "./validate.ts";

describe("parseExcerptAddRequest", () => {
  test("正常路径：带 turn 与缺席 turn 两种", () => {
    assert.deepEqual(parseExcerptAddRequest({ sessionId: "s1", turn: 2, role: "user", text: "hi" }), {
      sessionId: "s1",
      turn: 2,
      role: "user",
      text: "hi",
    });
    const noTurn = parseExcerptAddRequest({ sessionId: "s1", role: "assistant", text: "hi" });
    assert.deepEqual(noTurn, { sessionId: "s1", role: "assistant", text: "hi" });
    assert.equal("turn" in (noTurn ?? {}), false);
  });

  test("sessionId：非字符串 / 空串 → null", () => {
    assert.equal(parseExcerptAddRequest({ sessionId: "", role: "user", text: "hi" }), null);
    assert.equal(parseExcerptAddRequest({ sessionId: 7, role: "user", text: "hi" }), null);
    assert.equal(parseExcerptAddRequest({ role: "user", text: "hi" }), null);
  });

  test("role：只认 user / assistant", () => {
    assert.equal(parseExcerptAddRequest({ sessionId: "s1", role: "system", text: "hi" }), null);
    assert.equal(parseExcerptAddRequest({ sessionId: "s1", role: "USER", text: "hi" }), null);
    assert.equal(parseExcerptAddRequest({ sessionId: "s1", text: "hi" }), null);
  });

  test("turn：正整数或缺席；0 / 负数 / 小数 / 非数都不要", () => {
    const base = { sessionId: "s1", role: "user", text: "hi" };
    assert.equal(parseExcerptAddRequest({ ...base, turn: 1 })?.turn, 1);
    assert.equal(parseExcerptAddRequest({ ...base, turn: 0 }), null);
    assert.equal(parseExcerptAddRequest({ ...base, turn: -1 }), null);
    assert.equal(parseExcerptAddRequest({ ...base, turn: 1.5 }), null);
    assert.equal(parseExcerptAddRequest({ ...base, turn: "2" }), null);
    assert.equal(parseExcerptAddRequest({ ...base, turn: null }), null);
  });

  test("text：非字符串 / 空串 / 纯空白 → null；首尾空白本身合法（存储侧 trim）", () => {
    const base = { sessionId: "s1", role: "user" };
    assert.equal(parseExcerptAddRequest({ ...base, text: "  " }), null);
    assert.equal(parseExcerptAddRequest({ ...base, text: "\n\t" }), null);
    assert.equal(parseExcerptAddRequest({ ...base, text: "" }), null);
    assert.equal(parseExcerptAddRequest({ ...base, text: 42 }), null);
    assert.equal(parseExcerptAddRequest({ ...base, text: undefined }), null);
    assert.equal(parseExcerptAddRequest({ ...base, text: " 留白的正文 " })?.text, " 留白的正文 ");
  });

  test("非对象（null / 数组 / 字符串）→ null", () => {
    assert.equal(parseExcerptAddRequest(null), null);
    assert.equal(parseExcerptAddRequest("s1"), null);
    assert.equal(parseExcerptAddRequest([1, 2]), null);
  });
});

describe("parseExcerptRemoveRequest", () => {
  test("正常路径与非字符串 / 空串 id", () => {
    assert.deepEqual(parseExcerptRemoveRequest({ id: "exc_1" }), { id: "exc_1" });
    assert.equal(parseExcerptRemoveRequest({ id: "" }), null);
    assert.equal(parseExcerptRemoveRequest({ id: 1 }), null);
    assert.equal(parseExcerptRemoveRequest({}), null);
    assert.equal(parseExcerptRemoveRequest(null), null);
    assert.equal(parseExcerptRemoveRequest("exc_1"), null);
  });
});
