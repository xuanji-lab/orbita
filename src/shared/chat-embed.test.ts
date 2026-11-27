import { test } from "node:test";
import assert from "node:assert/strict";
import { HTML_EMBED_MAX_BYTES, chatEmbedHtmlOf, utf8Bytes } from "./chat-embed.ts";

test("chatEmbedHtmlOf：只收非空字符串，超字节上限拒绝", () => {
  assert.equal(chatEmbedHtmlOf(null), null);
  assert.equal(chatEmbedHtmlOf("x"), null);
  assert.equal(chatEmbedHtmlOf({}), null);
  assert.equal(chatEmbedHtmlOf({ html: 1 }), null);
  assert.equal(chatEmbedHtmlOf({ html: "" }), null);
  assert.equal(chatEmbedHtmlOf({ html: "<p>a</p>" }), "<p>a</p>");
  assert.equal(chatEmbedHtmlOf({ html: "a".repeat(HTML_EMBED_MAX_BYTES) }), "a".repeat(HTML_EMBED_MAX_BYTES));
  assert.equal(chatEmbedHtmlOf({ html: "a".repeat(HTML_EMBED_MAX_BYTES + 1) }), null);
  // 中文 3 字节：字符数没超、字节数超了
  assert.equal(chatEmbedHtmlOf({ html: "图".repeat(Math.ceil(HTML_EMBED_MAX_BYTES / 3) + 1) }), null);
});

test("utf8Bytes 与 TextEncoder 一致（含代理对）", () => {
  for (const text of ["", "abc", "图", "é", "😀", "a😀图b", "\ud800"]) {
    assert.equal(utf8Bytes(text), new TextEncoder().encode(text).length, JSON.stringify(text));
  }
});
