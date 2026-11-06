import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeQuotedMessage, parseQuotedMessage } from "../../../../shared/quote.ts";
import { lineOf, lineRangeOf, quoteOfPageSelection, quoteOfSelection, quoteOfSlide } from "./doc-quote.ts";

const DOC = "# Q4 计划\n\n## 目标\n\n把单 agent 立住。\n\n## 风险\n\n主要风险是验收只靠我一个人，界面问题往往要到真实例里才暴露。\n";

describe("行号", () => {
  it("偏移 → 行号（1 起）；越界夹住", () => {
    assert.equal(lineOf(DOC, 0), 1);
    assert.equal(lineOf(DOC, DOC.indexOf("## 目标")), 3);
    assert.equal(lineOf(DOC, 9999), DOC.split("\n").length);
  });

  it("选区终点恰在下一行行首：那一行不算", () => {
    const from = DOC.indexOf("## 目标");
    assert.deepEqual(lineRangeOf(DOC, from, from + "## 目标\n".length), { from: 3, to: 3 });
    assert.deepEqual(lineRangeOf(DOC, from, DOC.indexOf("把单")), { from: 3, to: 4 });
  });
});

describe("引用 —— 划选", () => {
  it("C1：选中一句 → 文件引用，带路径、原文、行号范围", () => {
    const from = DOC.indexOf("主要风险");
    const to = from + "主要风险是验收只靠我一个人".length;
    const quote = quoteOfSelection({ path: "/ws/Q4 计划.md", text: DOC, from, to });
    assert.deepEqual(quote, {
      text: "主要风险是验收只靠我一个人",
      messageId: "",
      role: "user",
      filePath: "/ws/Q4 计划.md",
      lines: { from: 9, to: 9 },
      context: { before: "单 agent 立住。\n\n## 风险\n\n", after: "，界面问题往往要到真实例里才暴露。\n" },
    });
  });

  it("引用的是源码原文：加粗符号保留，agent 用 edit 能在文件里逐字对上", () => {
    const text = "前文\n\n这句有 **加粗** 的词\n";
    const from = text.indexOf("这句");
    const quote = quoteOfSelection({ path: "/a.md", text, from, to: text.indexOf("\n", from) });
    assert.equal(quote?.text, "这句有 **加粗** 的词");
    assert.ok(text.includes(quote?.text ?? "x"));
  });

  it("空选区 / 全空白 → null；超长截断并标记", () => {
    assert.equal(quoteOfSelection({ path: "/a.md", text: DOC, from: 3, to: 3 }), null);
    assert.equal(quoteOfSelection({ path: "/a.md", text: "a\n\n\nb", from: 1, to: 4 }), null);
    const long = "字".repeat(2500);
    const quote = quoteOfSelection({ path: "/a.md", text: long, from: 0, to: long.length });
    assert.equal(quote?.truncated, true);
    assert.equal(Array.from(quote?.text ?? "").length, 2000);
  });

  it("发给模型再解析回来：行号不丢（输入框芯片与消息里的芯片同一份）", () => {
    const quote = quoteOfSelection({ path: "/ws/Q4 计划.md", text: DOC, from: DOC.indexOf("把单"), to: DOC.indexOf("立住") + 2 })!;
    const message = composeQuotedMessage([quote], "改得更口语", { path: "/ws/Q4 计划.md", kind: "doc" });
    const parsed = parseQuotedMessage(message);
    assert.deepEqual(parsed.quotes[0]?.lines, { from: 5, to: 5 });
    assert.equal(parsed.text, "改得更口语");
  });
});

describe("引用 —— 演示文稿的一页", () => {
  const DECK = "---\nmarp: true\n---\n\n# 一\n\n---\n\n# 二\n正文\n\n---\n\n# 三\n";

  it("G3：整页引用带页号与行号范围", () => {
    const quote = quoteOfSlide({ path: "/ws/d.md", text: DECK, page: 2 });
    assert.equal(quote?.slide, 3);
    assert.equal(quote?.text, "# 三");
    assert.deepEqual(quote?.lines, { from: 14, to: 14 });
    const second = quoteOfSlide({ path: "/ws/d.md", text: DECK, page: 1 });
    assert.deepEqual([second?.slide, second?.lines], [2, { from: 9, to: 10 }]);
  });

  it("页不存在 → null", () => {
    assert.equal(quoteOfSlide({ path: "/d.md", text: DECK, page: 9 }), null);
  });

  it("页内划选：行号按整份文件、页号按那一页", () => {
    const regionFrom = DECK.indexOf("# 二");
    const quote = quoteOfPageSelection({ path: "/d.md", fullText: DECK, regionFrom, from: 4, to: 6, page: 1 });
    assert.equal(quote?.text, "正文");
    assert.equal(quote?.slide, 2);
    assert.deepEqual(quote?.lines, { from: 10, to: 10 });
  });
});
