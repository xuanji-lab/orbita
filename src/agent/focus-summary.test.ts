/**
 * 专注收工小结 agent 侧纯函数的测试（focus-summary.ts）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FOCUS_SUMMARY_SYSTEM_PROMPT, parseSummaryReply } from "./focus-summary.ts";

describe("parseSummaryReply", () => {
  test("围栏 json：常规形态", () => {
    const reply = '好的，这是小结：\n```json\n{"bullets": ["建了 skill", "改了 Sidebar.tsx", "配了 MCP"]}\n```';
    assert.deepEqual(parseSummaryReply(reply), ["建了 skill", "改了 Sidebar.tsx", "配了 MCP"]);
  });
  test("无语言标注的围栏也认；前后说明文字容忍", () => {
    assert.deepEqual(parseSummaryReply('```\n{"bullets": ["a", "b"]}\n```'), ["a", "b"]);
  });
  test("没有围栏时取正文里的对象", () => {
    assert.deepEqual(parseSummaryReply('前面是废话 {"bullets": ["一", "二", "三"]} 后面也是'), ["一", "二", "三"]);
  });
  test("2 条与 5 条都在界内，6 条出界", () => {
    const of = (n: number): string => JSON.stringify({ bullets: Array.from({ length: n }, (_, i) => `第${i}条`) });
    assert.notEqual(parseSummaryReply("```json\n" + of(2) + "\n```"), null);
    assert.notEqual(parseSummaryReply("```json\n" + of(5) + "\n```"), null);
    assert.equal(parseSummaryReply("```json\n" + of(6) + "\n```"), null);
  });
  test("空串 / 非串元素剔除后不足 2 条 → null", () => {
    assert.equal(parseSummaryReply('```json\n{"bullets": ["唯一一条"]}\n```'), null);
    assert.equal(parseSummaryReply('```json\n{"bullets": ["a", "", "  "]}\n```'), null);
    assert.equal(parseSummaryReply('```json\n{"bullets": ["a", 3]}\n```'), null);
  });
  test("读不懂（缺 bullets / 坏 JSON / 空回复）→ null", () => {
    assert.equal(parseSummaryReply(""), null);
    assert.equal(parseSummaryReply("```json\n{\"items\": []}\n```"), null);
    assert.equal(parseSummaryReply("```json\n{broken}\n```"), null);
  });
  test("系统指令带着输出契约（措辞即契约，改动要有意识地同步解析器）", () => {
    assert.ok(FOCUS_SUMMARY_SYSTEM_PROMPT.includes('{"bullets"'));
    assert.ok(FOCUS_SUMMARY_SYSTEM_PROMPT.includes("2 到 5"));
  });
});
