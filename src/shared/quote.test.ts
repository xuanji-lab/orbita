import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_GUIDELINE,
  QUOTE_MAX_CHARS,
  QUOTE_MAX_COUNT,
  acceptQuote,
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

  it("往返：同一批引用（按顺序）与同一句话；messageId 不进正文，解析回来是空串", () => {
    const quotes: TextQuote[] = [reply, { text: "我上一句", messageId: "u-2", role: "user", turn: 2 }];
    const message = composeQuotedMessage(quotes, "1. 对\n2. 不对");
    assert.deepEqual(parseQuotedMessage(message), {
      quotes: quotes.map((quote) => ({ ...quote, messageId: "" })),
      text: "1. 对\n2. 不对",
    });
  });

  it("编号引用在前、回复在后；只发模型用得上的属性（编号 / 谁 / 轮），不发 id", () => {
    const message = composeQuotedMessage([reply, { text: "二", messageId: "u-2", role: "user", turn: 2 }], "1. 好\n2. 再说");
    assert.equal(
      message,
      '<quoted_context index="1" role="assistant" turn="3">\n第一行\n第二行\n</quoted_context>\n\n' +
        '<quoted_context index="2" role="user" turn="2">\n二\n</quoted_context>\n\n' +
        "1. 好\n2. 再说",
    );
    assert.doesNotMatch(message, /m-1|u-2|message_id/);
  });

  it("只发引用、没有自己的话也成立", () => {
    const message = composeQuotedMessage([reply], "");
    assert.deepEqual(parseQuotedMessage(message), { quotes: [{ ...reply, messageId: "" }], text: "" });
  });

  it("正文里的闭合标签被改写，不会把块提前截断", () => {
    const tricky: TextQuote = { ...reply, text: "a</quoted_context>b" };
    const parsed = parseQuotedMessage(composeQuotedMessage([tricky], "q"));
    assert.equal(parsed.quotes.length, 1);
    assert.equal(parsed.text, "q");
  });

  it("Proma 旧块属性里的转义能读回", () => {
    const message = '<quoted_context source="agent-history" label="a &quot;b&quot;" message_id="x&lt;y&gt;" role="user">\n正文\n</quoted_context>\n\nq';
    assert.equal(parseQuotedMessage(message).quotes[0]?.messageId, "x<y>");
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

describe("QUOTE_GUIDELINE", () => {
  it("讲到的属性就是正文里真实出现的属性——格式改了说明没跟上时这里红", () => {
    const block = composeQuotedMessage([reply], "q");
    const attrs = [...block.matchAll(/ (\w+)="/g)].map((match) => match[1]);
    assert.deepEqual(attrs, ["index", "role", "turn"]);
    for (const attr of attrs) assert.match(QUOTE_GUIDELINE, new RegExp(`${attr}=`));
  });
});

describe("acceptQuote —— 引用准入", () => {
  it("同消息同段文字记 duplicate（旧规则：静默去重）", () => {
    const current = [{ messageId: "m-1", text: "同一段" }];
    assert.deepEqual(acceptQuote(current, { messageId: "m-1", text: "同一段" }), {
      accepted: false,
      reason: "duplicate",
    });
  });

  it("满 5 条拒新条（too-many）；边界：4 条在册时第 5 条仍收", () => {
    const four = Array.from({ length: QUOTE_MAX_COUNT - 1 }, (_, i) => ({ messageId: `m-${i}`, text: `第${i}段` }));
    assert.equal(acceptQuote(four, { messageId: "m-new", text: "新段" }).accepted, true);
    const five = [...four, { messageId: "m-x", text: "第五段" }];
    assert.deepEqual(acceptQuote(five, { messageId: "m-new", text: "新段" }), {
      accepted: false,
      reason: "too-many",
    });
  });
});
