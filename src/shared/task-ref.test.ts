import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeTaskRefMessage, parseTaskRefPayload, parseTaskRefs, type TaskRef } from "./task-ref.ts";
import { composeQuotedMessage, parseQuotedMessage, withoutQuotes } from "./quote.ts";

const a: TaskRef = { id: "3ae38a33-93c8-4602-bc9c-ab232c2f8c94", title: "审核PR验收顺序与测试" };
const b: TaskRef = { id: "f820e8de-384b-4b3a-b60c-789aa0d1cf86", title: 'a "b" <c> & d\n第二行' };

describe("任务引用（会话拖进输入框）", () => {
  it("没有引用原样返回，一字不差", () => {
    assert.equal(composeTaskRefMessage([], "你好"), "你好");
    assert.deepEqual(parseTaskRefs("你好"), { tasks: [], text: "你好" });
  });

  it("一行一条排在最前，带完整 id；往返拿回同一批引用与同一句话", () => {
    const message = composeTaskRefMessage([a, b], "对比一下这两个");
    assert.match(message, /^<referenced_task id="3ae38a33-93c8-4602-bc9c-ab232c2f8c94" title="审核PR验收顺序与测试" \/>\n/);
    assert.equal(message.split("\n\n").length, 2, "引用行之间不留空行（回显按空行切块，一组引用要落在同一块里）");
    assert.deepEqual(parseTaskRefs(message), {
      tasks: [a, { ...b, title: 'a "b" <c> & d 第二行' }],
      text: "对比一下这两个",
    });
  });

  it("只拖会话不打字也成立", () => {
    assert.deepEqual(parseTaskRefs(composeTaskRefMessage([a], "")), { tasks: [a], text: "" });
  });

  it("与编号引用并存：任务引用在前、引用块随后；parseQuotedMessage 两样都拆出来", () => {
    const quoted = composeQuotedMessage([{ text: "原话", messageId: "m", role: "assistant", turn: 2 }], "回复");
    const parsed = parseQuotedMessage(composeTaskRefMessage([a], quoted));
    assert.deepEqual(parsed.tasks, [a]);
    assert.equal(parsed.quotes.length, 1);
    assert.equal(parsed.text, "回复");
  });

  it("withoutQuotes 也剥掉任务引用：侧栏标题 / 最近提问不会是一行裸标签", () => {
    assert.equal(withoutQuotes(composeTaskRefMessage([a], "接着做")), "接着做");
  });

  it("没有 id 的行原样留着，不吞内容", () => {
    const broken = '<referenced_task title="x" />\n\nq';
    assert.deepEqual(parseTaskRefs(broken), { tasks: [], text: broken });
  });

  it("拖拽 payload：只认带 id 的 JSON", () => {
    assert.deepEqual(parseTaskRefPayload(JSON.stringify(a)), a);
    assert.deepEqual(parseTaskRefPayload('{"id":"x"}'), { id: "x", title: "" });
    assert.equal(parseTaskRefPayload('{"title":"x"}'), null);
    assert.equal(parseTaskRefPayload("not json"), null);
  });
});
