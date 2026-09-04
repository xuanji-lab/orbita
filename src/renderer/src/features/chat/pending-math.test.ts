import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { closePendingMath } from "./pending-math.ts";

describe("closePendingMath", () => {
  it("全部闭合时原样返回", () => {
    deepStrictEqual(closePendingMath("值 $x$ 与 $$y$$ 相等"), "值 $x$ 与 $$y$$ 相等");
    deepStrictEqual(closePendingMath("没有公式的一段话"), "没有公式的一段话");
  });

  it("尾部未闭合的 $$ 补 $$", () => {
    deepStrictEqual(closePendingMath("推导：\n$$x = \\frac{1}{2"), "推导：\n$$x = \\frac{1}{2$$");
  });

  it("尾部未闭合的 $ 补 $", () => {
    deepStrictEqual(closePendingMath("值是 $x"), "值是 $x$");
  });

  it("代码围栏里的 $ 不算定界符", () => {
    const fenced = "```\n$a$\n```\n看 $x";
    deepStrictEqual(closePendingMath(fenced), fenced + "$");
    const balanced = "```\n$a$\n```\n看 $x$ 好";
    deepStrictEqual(closePendingMath(balanced), balanced);
  });

  it("行内 code span 里的 $ 不算定界符", () => {
    const span = "用 `` `$x$` `` 与 $y$ 对照";
    deepStrictEqual(closePendingMath(span), span);
  });

  it("\\$ 转义不算定界符", () => {
    const money = "价格 \\$5 和 \\$6";
    deepStrictEqual(closePendingMath(money), money);
  });

  it("已平衡的金额串不补（降级是下游 remark 的职责）", () => {
    deepStrictEqual(closePendingMath("$5 and $10"), "$5 and $10");
  });

  it("$$ 开着时单个 $ 视作公式内容", () => {
    deepStrictEqual(closePendingMath("$$a $ b"), "$$a $ b$$");
  });

  it("空串原样返回", () => {
    deepStrictEqual(closePendingMath(""), "");
  });
});
