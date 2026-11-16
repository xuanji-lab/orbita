import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { queueNote } from "./queue-note.ts";
import { zh } from "../../messages-zh.ts";

describe("queueNote：排队条注脚照实说什么时候发出", () => {
  it("已插进这一轮的那条：说「当前这一步做完就送到」，不说等这一轮结束", () => {
    assert.equal(queueNote({ id: "a", kind: "text", text: "插话", steered: true }, "turn", zh), "已插进这一轮，当前这一步做完就送到");
    assert.equal(queueNote({ id: "b", kind: "text", text: "排队" }, "turn", zh), "这一轮结束后发出");
  });
  it("插话被退回 / 这一轮已结束：按普通排队说（空闲时随下一条发出）", () => {
    assert.equal(queueNote({ id: "a", kind: "text", text: "插话", steered: true }, "idle", zh), "随你的下一条消息发出");
    assert.equal(queueNote({ id: "k", kind: "compact" }, "turn", zh), zh.queue.compactsWhenIdle);
  });
});
