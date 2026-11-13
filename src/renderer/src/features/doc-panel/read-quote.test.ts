import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { plainParagraphs, sourceRangeOfSelection } from "./read-quote.ts";
import { quoteOfSelection } from "./doc-quote.ts";

const DOC = [
  "# 周报", // 1
  "", // 2
  "设计方向 N 落地，正文列定为 ==900==；详见 [[设计系统迭代记录]]，**加粗字** 在这里。", // 3
  "", // 4
  "- 第一项 `代码` 说明", // 5
  "- 第二项", // 6
  "", // 7
  "最后一段文字。", // 8
].join("\n");

const slice = (r: { from: number; to: number } | null): string | null => (r === null ? null : DOC.slice(r.from, r.to));

describe("阅读视图划选 → 源码区间", () => {
  it("块内选中纯文字：精确到字", () => {
    assert.equal(slice(sourceRangeOfSelection(DOC, { sl: 3, el: 3 }, { sl: 3, el: 3 }, "正文列定为")), "正文列定为");
  });

  it("选区跨过强调 / 高亮 / 行内代码标记：源码里带着标记原样给出", () => {
    assert.equal(slice(sourceRangeOfSelection(DOC, { sl: 3, el: 3 }, { sl: 3, el: 3 }, "定为900；详见")), "定为 ==900==；详见");
    assert.equal(slice(sourceRangeOfSelection(DOC, { sl: 5, el: 5 }, { sl: 5, el: 5 }, "第一项代码说明")), "第一项 `代码` 说明");
    assert.equal(slice(sourceRangeOfSelection(DOC, { sl: 3, el: 3 }, { sl: 3, el: 3 }, "加粗字")), "加粗字");
  });

  it("选区跨过双链语法（渲染文字对不上源码）：退回整块的源码行", () => {
    assert.equal(
      slice(sourceRangeOfSelection(DOC, { sl: 3, el: 3 }, { sl: 3, el: 3 }, "详见 设计系统迭代记录，加粗字")),
      "设计方向 N 落地，正文列定为 ==900==；详见 [[设计系统迭代记录]]，**加粗字** 在这里。",
    );
  });

  it("跨块：起点在起始块、终点在结束块里各自精确定位", () => {
    const r = sourceRangeOfSelection(DOC, { sl: 5, el: 5 }, { sl: 8, el: 8 }, "说明\n第二项\n\n最后一段");
    assert.equal(slice(r), "说明\n- 第二项\n\n最后一段");
    // 结束块里的结尾对不上：退到结束块行末
    assert.equal(slice(sourceRangeOfSelection(DOC, { sl: 5, el: 5 }, { sl: 8, el: 8 }, "说明\n第二项\n\n不存在的结尾xyz")), "说明\n- 第二项\n\n最后一段文字。");
  });

  it("空选区 / 越界 = null", () => {
    assert.equal(sourceRangeOfSelection(DOC, { sl: 3, el: 3 }, { sl: 3, el: 3 }, "   "), null);
    assert.equal(sourceRangeOfSelection("", { sl: 1, el: 1 }, { sl: 1, el: 1 }, "x"), null);
    assert.equal(sourceRangeOfSelection(DOC, { sl: 8, el: 8 }, { sl: 3, el: 3 }, "x"), null);
  });

  it("接 quoteOfSelection：引用带源码原文与文件里的行号", () => {
    const range = sourceRangeOfSelection(DOC, { sl: 5, el: 5 }, { sl: 6, el: 6 }, "说明\n第二项");
    assert.ok(range !== null);
    const quote = quoteOfSelection({ path: "/w/周报.md", text: DOC, from: range.from, to: range.to });
    assert.ok(quote !== null);
    assert.equal(quote.filePath, "/w/周报.md");
    assert.deepEqual(quote.lines, { from: 5, to: 6 });
    assert.equal(quote.text, "说明\n- 第二项");
  });

  it(".txt 按空行切段并带上在文件里的起止行", () => {
    const text = "第一段\n接着一行\n\n\n第二段\n\n第三段";
    assert.deepEqual(plainParagraphs(text), [
      { text: "第一段\n接着一行", sl: 1, el: 2 },
      { text: "第二段", sl: 5, el: 5 },
      { text: "第三段", sl: 7, el: 7 },
    ]);
    // 切出的段能接上源码区间：第二段在第 5 行
    const hit = sourceRangeOfSelection(text, { sl: 5, el: 5 }, { sl: 5, el: 5 }, "第二段");
    assert.ok(hit !== null);
    assert.equal(text.slice(hit.from, hit.to), "第二段");
  });
});
