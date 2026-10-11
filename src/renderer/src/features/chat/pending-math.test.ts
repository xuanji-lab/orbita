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

  it("code span 里的单个 $（奇数个）不打开定界符、不触发结尾补全", () => {
    // 2026-10 事故样本：句中 `$` 被当成开定界符，回复结尾凭空多出一个 $
    const text = "- 用户消息里的 `$` 被当成数学公式…\n\n要先合 204 和 205 吗？";
    deepStrictEqual(closePendingMath(text), text);
  });

  it("code span 里的 $ 也不抵消外部已开的公式", () => {
    // $a 开在 span 外，span 里的 $ 是内容；只有真正的尾部未闭合才补
    const text = "公式 $a 与代码 `$` 同句";
    deepStrictEqual(closePendingMath(text), text + "$");
  });

  it("多个 code span 各自跳过，不互相记账", () => {
    const text = "`a$` 和 `b$` 之后看 $x";
    deepStrictEqual(closePendingMath(text), text + "$");
    const balanced = "`a$` 和 `b$` 之后看 $x$ 好";
    deepStrictEqual(closePendingMath(balanced), balanced);
  });

  it("双反引号 span 里的 `$x$` 整对不算定界符", () => {
    // span 由 `` 开关，中间的 $x$ 只是内容；外部真正的 $y 未闭合才补
    const text = "代码 `` `$x$` `` 与公式 $y";
    deepStrictEqual(closePendingMath(text), text + "$");
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
