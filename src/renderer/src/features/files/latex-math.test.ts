/**
 * 公式扫描（latex-math.ts）的账：四种定界符、未闭合不命中、注释 / 字面量排除、
 * 转义字面量不算定界符、命中判断的边界语义。
 *
 * 只测纯逻辑——KaTeX 的渲染在接线层，node 加载不了它的 CSS。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findTexMath, scanTexMath } from "./latex-math.ts";

describe("scanTexMath", () => {
  test("行内 $...$：返回原文、公式体与区间", () => {
    const text = "so $x^2$ works";
    const [range] = scanTexMath(text);
    assert.equal(range?.text, "$x^2$");
    assert.equal(range?.body, "x^2");
    assert.equal(range?.display, false);
    assert.equal(text.slice(range?.from, range?.to), "$x^2$");
  });

  test("$$...$$ 与 \\[...\\] 是块级（display），允许跨行", () => {
    const text = ["a $$", "\\frac{a}{b}", "$$ b \\[", "c", "\\]"].join("\n");
    const ranges = scanTexMath(text);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0]?.display, true);
    assert.equal(ranges[0]?.body, "\n\\frac{a}{b}\n");
    assert.equal(ranges[1]?.display, true);
    assert.equal(ranges[1]?.body, "\nc\n");
  });

  test("\\(...\\) 行内命中；跨行不命中（漏写的定界符不许吞掉后文）", () => {
    assert.equal(scanTexMath("a \\(x+1\\) b")[0]?.body, "x+1");
    assert.deepEqual(scanTexMath("a \\(x+1\nb\\) c"), []);
  });

  test("未闭合不命中（$ / $$ / \\( / \\[ 四种）", () => {
    assert.deepEqual(scanTexMath("price $x and more"), []);
    assert.deepEqual(scanTexMath("$$x"), []);
    assert.deepEqual(scanTexMath("\\(x"), []);
    assert.deepEqual(scanTexMath("\\[x"), []);
  });

  test("注释里的不命中；转义的 \\% 后面仍是公式", () => {
    assert.deepEqual(scanTexMath("% $x^2$ in a comment"), []);
    const ranges = scanTexMath("50\\% of $x$");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.body, "x");
  });

  test("\\$ 是美元符号，不是定界符", () => {
    assert.deepEqual(scanTexMath("costs \\$5 and \\$7"), []);
  });

  test("\\\\[2pt] 是换行命令，不是 \\[ 定界符", () => {
    assert.deepEqual(scanTexMath("line one\\\\[2pt] line two"), []);
  });

  test("verbatim 环境与 \\verb|…| 里的 $ 不算公式", () => {
    assert.deepEqual(scanTexMath("\\begin{verbatim}\n$x$\n\\end{verbatim}"), []);
    assert.deepEqual(scanTexMath("\\verb|$x$| ok"), []);
    assert.equal(scanTexMath("\\begin{verbatim}$y$\\end{verbatim}\n$x$").length, 1);
  });

  test("多个公式按出现顺序；$$ 内部的单个 $ 不另开一段", () => {
    const ranges = scanTexMath("$a$ then $$b $ c$$ then \\(d\\)");
    assert.deepEqual(ranges.map((range) => range.body), ["a", "b $ c", "d"]);
  });

  test("空公式不产生区间", () => {
    assert.deepEqual(scanTexMath("$$$$"), []);
    assert.deepEqual(scanTexMath("$$ $$"), []);
  });
});

describe("findTexMath", () => {
  const text = "pre $x^2$ post \\(y\\)";
  const [inline] = scanTexMath(text);

  test("落在公式内（含开定界符）命中", () => {
    assert.equal(findTexMath(text, inline?.from ?? 0)?.body, "x^2");
    assert.equal(findTexMath(text, (inline?.from ?? 0) + 2)?.body, "x^2");
  });

  test("落在闭定界符之后、公式外不命中", () => {
    assert.equal(findTexMath(text, (inline?.to ?? 0) + 1), null);
    assert.equal(findTexMath(text, 0), null);
  });

  test("第二段公式也能命中", () => {
    assert.equal(findTexMath(text, text.indexOf("\\(") + 1)?.body, "y");
  });
});
