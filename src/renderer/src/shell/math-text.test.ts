import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { containsMathDelimiter, splitMathSegments } from "./math-text.ts";

/** 往返不变量：按段类型补回定界符后，拼接必须还原原文（渲染器靠它不丢字、不错位） */
function source(segments: ReturnType<typeof splitMathSegments>): string {
  return segments
    .map((s) =>
      s.kind === "text" ? s.value : s.kind === "inlineMath" ? `$${s.value}$` : `$$${s.value}$$`,
    )
    .join("");
}

describe("splitMathSegments", () => {
  test("没有公式：整段就是一条文本", () => {
    assert.deepEqual(splitMathSegments("hello 世界"), [{ kind: "text", value: "hello 世界" }]);
  });

  test("行内公式跟着文字流走", () => {
    assert.deepEqual(splitMathSegments("面积 $A = r^2$ 好的"), [
      { kind: "text", value: "面积 " },
      { kind: "inlineMath", value: "A = r^2" },
      { kind: "text", value: " 好的" },
    ]);
  });

  test("块级公式单独成段（居中渲染归组件管）", () => {
    assert.deepEqual(splitMathSegments("积分 $$\\int_0^1 x$$ 完"), [
      { kind: "text", value: "积分 " },
      { kind: "blockMath", value: "\\int_0^1 x" },
      { kind: "text", value: " 完" },
    ]);
  });

  test("金额防误判：贴空白的行内定界符全部还原成文本（math-guard 同规则）", () => {
    const segments = splitMathSegments("花了 $5 and $10，不便宜");
    assert.ok(segments.every((s) => s.kind === "text"));
    assert.equal(source(segments), "花了 $5 and $10，不便宜");
  });

  test("金额防误判对未闭合的尾 $ 同样生效", () => {
    const segments = splitMathSegments("花了 $5 and ");
    assert.ok(segments.every((s) => s.kind === "text"));
    assert.equal(source(segments), "花了 $5 and ");
  });

  test("未闭合的行内公式按已闭合渲染（pending 同规则）", () => {
    assert.deepEqual(splitMathSegments("值是 $E=mc"), [
      { kind: "text", value: "值是 " },
      { kind: "inlineMath", value: "E=mc" },
    ]);
  });

  test("未闭合的块级公式整段收进 blockMath", () => {
    assert.deepEqual(splitMathSegments("积分：$$\\int_0^1"), [
      { kind: "text", value: "积分：" },
      { kind: "blockMath", value: "\\int_0^1" },
    ]);
  });

  test("块级内部的 $ 不打断块级（$$ 优先于 $）", () => {
    assert.deepEqual(splitMathSegments("$$a$b$$"), [{ kind: "blockMath", value: "a$b" }]);
  });

  test("多段混排保持顺序且无损", () => {
    const text = "$a$ x $$b$$ y $c$";
    const segments = splitMathSegments(text);
    assert.deepEqual(
      segments.map((s) => s.kind),
      ["inlineMath", "text", "blockMath", "text", "inlineMath"],
    );
    assert.equal(source(segments), text);
  });

  test("切多行的块级公式照常成段", () => {
    const text = "看：$$x \n= y$$ 完";
    const segments = splitMathSegments(text);
    assert.deepEqual(segments, [
      { kind: "text", value: "看：" },
      { kind: "blockMath", value: "x \n= y" },
      { kind: "text", value: " 完" },
    ]);
  });
});

describe("containsMathDelimiter", () => {
  test("有 $ 就 true", () => {
    assert.equal(containsMathDelimiter("a $ b"), true);
  });
  test("没有就 false", () => {
    assert.equal(containsMathDelimiter("纯文字"), false);
  });
});
