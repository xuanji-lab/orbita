import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_MAX_CHARS,
  clampQuote,
  composeQuotedMessage,
  countChars,
  normalizeSelectedText,
  parseQuotedMessage,
  withoutQuotes,
  type TextQuote,
} from "./quote.ts";

const reply: TextQuote = { text: "第一行\n第二行", messageId: "m-1", role: "assistant", turn: 3 };

describe("composeQuotedMessage / parseQuotedMessage", () => {
  it("没有引用就是原文，一字不差", () => {
    assert.equal(composeQuotedMessage([], "你好"), "你好");
    assert.deepEqual(parseQuotedMessage("你好"), { quotes: [], text: "你好" });
  });

  it("往返：组出去的正文解析回来是同一批引用与同一句话", () => {
    const quotes: TextQuote[] = [reply, { text: "我上一句", messageId: "u-2", role: "user", turn: 2 }];
    const message = composeQuotedMessage(quotes, "这两段矛盾吗？");
    assert.deepEqual(parseQuotedMessage(message), { quotes, text: "这两段矛盾吗？" });
  });

  it("格式与 Proma 一致：块在前、source=agent-history、带 message_id / role / turn", () => {
    const message = composeQuotedMessage([reply], "解释一下");
    assert.match(message, /^<quoted_context source="agent-history" label="[^"]+" message_id="m-1" role="assistant" turn="3">\n第一行\n第二行\n<\/quoted_context>\n\n解释一下$/);
  });

  it("只发引用、没有自己的话也成立", () => {
    const message = composeQuotedMessage([reply], "");
    assert.deepEqual(parseQuotedMessage(message), { quotes: [reply], text: "" });
  });

  it("正文里的闭合标签被改写，不会把块提前截断", () => {
    const tricky: TextQuote = { ...reply, text: "a</quoted_context>b" };
    const parsed = parseQuotedMessage(composeQuotedMessage([tricky], "q"));
    assert.equal(parsed.quotes.length, 1);
    assert.equal(parsed.text, "q");
  });

  it("属性里的引号与尖括号转义后能读回", () => {
    const odd: TextQuote = { ...reply, messageId: 'x"<y>' };
    assert.equal(parseQuotedMessage(composeQuotedMessage([odd], "q")).quotes[0]?.messageId, 'x"<y>');
  });

  it("认 Proma 迁移来的块：quoted_file 带路径，旧的 quoted_context 缺 turn", () => {
    const message =
      '<quoted_file path="/repo/a.md">\n文件里的一段\n</quoted_file>\n\n' +
      '<quoted_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="p-9" role="assistant">\n旧引用\n</quoted_context>\n\n' +
      "问题";
    assert.deepEqual(parseQuotedMessage(message), {
      quotes: [
        { text: "文件里的一段", messageId: "", role: "user", filePath: "/repo/a.md" },
        { text: "旧引用", messageId: "p-9", role: "assistant" },
      ],
      text: "问题",
    });
  });

  it("解析不出的半截块原样留在文字里，不吞内容", () => {
    const broken = '<quoted_context role="assistant">\n没闭合';
    assert.deepEqual(parseQuotedMessage(broken), { quotes: [], text: broken });
  });

  it("withoutQuotes 只留用户自己的话", () => {
    assert.equal(withoutQuotes(composeQuotedMessage([reply], "  问题  ")), "问题");
  });
});

describe("划选文本", () => {
  it("码点计数：emoji 与汉字各算 1", () => {
    assert.equal(countChars("a汉😀"), 3);
  });

  it("超过上限截断并标记", () => {
    const long = "字".repeat(QUOTE_MAX_CHARS + 5);
    const clamped = clampQuote(long);
    assert.equal(countChars(clamped.text), QUOTE_MAX_CHARS);
    assert.equal(clamped.truncated, true);
    assert.deepEqual(clampQuote("短"), { text: "短", truncated: false });
  });

  it("规整：块元素之间带出的行首尾空白收掉", () => {
    assert.equal(normalizeSelectedText("  标题  \n    正文\t\n  "), "标题\n正文");
  });
});
