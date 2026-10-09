import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { quoteMeta, quotePreview, quoteRowPreview, quoteSource, QUOTE_ROW_PREVIEW_MAX_CHARS } from "./quote-label.ts";
import { en } from "../messages-en.ts";
import { zh } from "../messages-zh.ts";

describe("引用 chip 文案", () => {
  test("来源：第 N 轮 · 谁说的；没有轮号只说谁；文件取文件名", () => {
    assert.equal(quoteSource({ text: "x", messageId: "m", role: "assistant", turn: 3 }, zh), "第 3 轮 · 智能体回复");
    assert.equal(quoteSource({ text: "x", messageId: "m", role: "user" }, en), "Your message");
    assert.equal(quoteSource({ text: "x", messageId: "", role: "user", filePath: "/a/b/notes.md" }, en), "notes.md");
  });

  test("meta 带字数；截过的如实标出", () => {
    assert.equal(quoteMeta({ text: "a汉😀", messageId: "m", role: "user", turn: 1 }, zh), "第 1 轮 · 你的消息 · 3 字");
    assert.equal(
      quoteMeta({ text: "字字", messageId: "m", role: "user", turn: 1, truncated: true }, zh),
      "第 1 轮 · 你的消息 · 只引了前 2 字",
    );
  });

  test("收起态正文取前 20 字，超出才加省略号，空白压成一格", () => {
    const long = { text: "一二三四五六七八九十\n一二三四五六七八九十多", messageId: "m", role: "assistant" as const, turn: 2 };
    assert.equal(quotePreview(long), "一二三四五六七八九十 一二三四五六七八九…");
    assert.equal(quotePreview({ text: "短句", messageId: "m", role: "assistant", turn: 2 }), "短句");
  });

  test("引用卡一行不预截：长正文整段交给 CSS 裁，只压平空白", () => {
    const long = { text: "一二三四五六七八九十\n一二三四五六七八九十多", messageId: "m", role: "assistant" as const, turn: 2 };
    assert.equal(quoteRowPreview(long), "一二三四五六七八九十 一二三四五六七八九十多");
    assert.equal(quoteRowPreview({ text: "短句", messageId: "m", role: "assistant", turn: 2 }), "短句");
  });

  test("引用卡一行只设 300 字安全上限：超出截断加省略号", () => {
    const base = "一二三四五六七八九十".repeat(40); // 400 字
    const out = quoteRowPreview({ text: base, messageId: "m", role: "assistant", turn: 1 });
    assert.equal(Array.from(out).length, QUOTE_ROW_PREVIEW_MAX_CHARS + 1); // 300 字 + 省略号
    assert.equal(Array.from(out).at(-1), "…");
    // 上限内不省略
    const within = quoteRowPreview({ text: "一二三四五六七八九十".repeat(30), messageId: "m", role: "assistant", turn: 1 });
    assert.equal(Array.from(within).length, 300);
    assert.equal(Array.from(within).at(-1), "十");
  });
});
