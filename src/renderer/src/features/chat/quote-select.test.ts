import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { locateQuote, quoteFromSelection } from "./quote-select.ts";
import { QUOTE_MAX_CHARS } from "../../../../shared/quote.ts";

const user = (id: string): TranscriptItem => ({ id, role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 });
const reply = (id: string, status: "complete" | "streaming" = "complete"): TranscriptItem =>
  ({
    id,
    role: "assistant",
    content: [{ type: "text", text: "a" }],
    model: { provider: "p", id: "m" },
    timestamp: 2,
    status,
    ...(status === "complete" ? { stopReason: "stop" } : {}),
  }) as TranscriptItem;

const transcript = [user("u1"), reply("a1"), user("u2"), reply("a2"), reply("a3", "streaming")];

describe("quoteFromSelection", () => {
  test("轮号按用户消息计：用户消息是自己那轮，回复属于前一条用户消息的轮", () => {
    assert.equal(quoteFromSelection(transcript, "u1", "user", "x")?.turn, 1);
    assert.equal(quoteFromSelection(transcript, "a1", "assistant", "x")?.turn, 1);
    assert.equal(quoteFromSelection(transcript, "u2", "user", "x")?.turn, 2);
    assert.equal(quoteFromSelection(transcript, "a2", "assistant", "x")?.turn, 2);
  });

  test("流式中的回复、不在转录里的消息、角色对不上、空选区都不成引用", () => {
    assert.equal(quoteFromSelection(transcript, "a3", "assistant", "x"), null);
    assert.equal(quoteFromSelection(transcript, "nope", "assistant", "x"), null);
    assert.equal(quoteFromSelection(transcript, "u1", "assistant", "x"), null);
    assert.equal(quoteFromSelection(transcript, "a1", "assistant", "  \n "), null);
  });

  test("文本规整并截到上限，截过的带标记", () => {
    const quote = quoteFromSelection(transcript, "a1", "assistant", `  ${"字".repeat(QUOTE_MAX_CHARS + 1)}  `);
    assert.equal(quote?.truncated, true);
    assert.equal(Array.from(quote?.text ?? "").length, QUOTE_MAX_CHARS);
    assert.equal(quoteFromSelection(transcript, "a1", "assistant", "短")?.truncated, undefined);
  });
});

describe("locateQuote", () => {
  test("跨文本节点、忽略空白差异地找到起止", () => {
    // DOM 里是「标题」「\n  」「第一段正文」三个节点，划选规整后是「标题\n第一段」
    const at = locateQuote(["标题", "\n  ", "第一段正文"], "标题\n第一段");
    assert.deepEqual(at, { start: { node: 0, offset: 0 }, end: { node: 2, offset: 3 } });
  });

  test("找不到或引用全是空白时返回 null", () => {
    assert.equal(locateQuote(["abc"], "xyz"), null);
    assert.equal(locateQuote(["abc"], "  "), null);
  });
});
