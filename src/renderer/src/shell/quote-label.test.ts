import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { quoteMeta, quoteSource, quoteSummary } from "./quote-label.ts";
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

  test("摘要取前 20 字，超出才加省略号，空白压成一格", () => {
    const long = { text: "一二三四五六七八九十\n一二三四五六七八九十多", messageId: "m", role: "assistant" as const, turn: 2 };
    assert.equal(quoteSummary(long, zh), "第 2 轮 · 智能体回复 · 22 字 · 一二三四五六七八九十 一二三四五六七八九…");
    const short = { text: "短句", messageId: "m", role: "assistant" as const, turn: 2 };
    assert.equal(quoteSummary(short, zh), "第 2 轮 · 智能体回复 · 2 字 · 短句");
  });
});
