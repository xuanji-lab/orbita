import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { middleTruncate, quoteMeta, quoteNoteParts, quotePreview, quoteRowPreview, quoteSource, QUOTE_ROW_PREVIEW_MAX_CHARS } from "./quote-label.ts";
import { en } from "../messages-en.ts";
import { zh } from "../messages-zh.ts";

describe("引用 chip 文案", () => {
  test("来源：第 N 轮 · 谁说的；没有轮号只说谁；文件取文件名", () => {
    assert.equal(quoteSource({ text: "x", messageId: "m", role: "assistant", turn: 3 }, zh), "第 3 轮 · 智能体回复");
    assert.equal(quoteSource({ text: "x", messageId: "m", role: "user" }, en), "Your message");
    assert.equal(quoteSource({ text: "x", messageId: "", role: "user", filePath: "/a/b/notes.md" }, en), "notes.md");
  });

  test("文档里的引用：文件名 · 第几行；演示文稿再加页号（C1：芯片显示所在位置）", () => {
    const doc = { text: "主要风险", messageId: "", role: "user" as const, filePath: "/ws/Q4 计划.md", lines: { from: 12, to: 14 } };
    assert.equal(quoteSource(doc, zh), "Q4 计划.md · 第 12–14 行");
    assert.equal(quoteSource({ ...doc, lines: { from: 9, to: 9 } }, zh), "Q4 计划.md · 第 9 行");
    assert.equal(quoteSource({ ...doc, slide: 3 }, en), "Q4 计划.md · page 3 · lines 12–14");
    assert.equal(quoteMeta(doc, zh), "Q4 计划.md · 第 12–14 行 · 4 字");
  });

  test("文件引用有位置时：位置是 lead、文件名单列（窄格先省文件名）", () => {
    const doc = { text: "abc", messageId: "", role: "user" as const, filePath: "/ws/Q4 计划.md", lines: { from: 9, to: 9 } };
    assert.deepEqual(quoteNoteParts(doc, zh), { lead: "第 9 行", who: null, size: "3 字", file: "Q4 计划.md" });
    assert.equal(quoteNoteParts({ ...doc, ambiguous: { was: 9, at: [9, 11] } }, zh).lead, "待确认哪一处");
  });

  test("meta 带字数；截过的如实标出", () => {
    assert.equal(quoteMeta({ text: "a汉😀", messageId: "m", role: "user", turn: 1 }, zh), "第 1 轮 · 你的消息 · 3 字");
    assert.equal(
      quoteMeta({ text: "字字", messageId: "m", role: "user", turn: 1, truncated: true }, zh),
      "第 1 轮 · 你的消息 · 只引了前 2 字",
    );
  });

  test("注脚分段（引用卡两列窄格里藏「谁说的」用）：轮次 / 谁 / 字数三段", () => {
    assert.deepEqual(quoteNoteParts({ text: "abc", messageId: "m", role: "user", turn: 2 }, en), {
      lead: "Turn 2",
      who: "Your message",
      size: "3 chars",
      file: null,
    });
    // 没有轮号：lead 为 null，拼时不多出一个空段
    assert.deepEqual(quoteNoteParts({ text: "abc", messageId: "m", role: "assistant" }, en), {
      lead: null,
      who: "Agent reply",
      size: "3 chars",
      file: null,
    });
    // 文件来源：不拆 who
    assert.deepEqual(
      quoteNoteParts({ text: "abc", messageId: "", role: "user", filePath: "/a/b/notes.md" }, en),
      { lead: "notes.md", who: null, size: "3 chars", file: null },
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

describe("芯片上的文件名：先保文件名与页号，太长从中间省略", () => {
  test("middleTruncate：不超限原样；超限保头保尾（扩展名在）；按码点算", () => {
    assert.equal(middleTruncate("新加坡夜空.slides.json"), "新加坡夜空.slides.json");
    const out = middleTruncate("花园城市新加坡介绍的最终修订版（给董事会）.slides.json");
    assert.equal(Array.from(out).length, 20);
    assert.match(out, /^花园城市新加坡/);
    assert.match(out, /….*son$/);
    assert.equal(middleTruncate("😀".repeat(30)).includes("…"), true);
  });

  test("演示文稿的引用：注脚是「文件名 · 第 n 页」，文件名整名给出（不再靠 CSS 挤成「新…」）", () => {
    const deck = { text: "[图片]", messageId: "", role: "user" as const, filePath: "/ws/新加坡夜空.slides.json", slide: 2 };
    assert.deepEqual(quoteNoteParts(deck, zh), { lead: "第 2 页", who: null, size: "4 字", file: "新加坡夜空.slides.json" });
    const long = quoteNoteParts({ ...deck, filePath: "/ws/花园城市新加坡介绍的最终修订版（给董事会）.slides.json" }, zh);
    assert.ok(Array.from(long.file ?? "").length <= 20);
    assert.equal(long.lead, "第 2 页");
  });
});
