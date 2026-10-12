import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { demoteBoundaryMath } from "./math-guard.ts";

/** 与 demoteBoundaryMath 入参结构兼容的最小树类型，测试里不再和 never 搏斗 */
interface AnyNode {
  type: string;
  value?: string;
  children?: AnyNode[];
}

/** 造一棵最小的 mdast 形状树 */
function root(children: AnyNode[]): AnyNode {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

describe("demoteBoundaryMath", () => {
  it("值以空白结尾（$5 and $10 的实测产物）降级回文本", () => {
    const tree = root([
      { type: "text", value: "a " },
      { type: "inlineMath", value: "5 and " },
      { type: "text", value: " b" },
    ]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[1], { type: "text", value: "$5 and $" });
  });

  it("值以空白开头同样降级", () => {
    const tree = root([{ type: "inlineMath", value: " 和 " }]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[0], { type: "text", value: "$ 和 $" });
  });

  it("真公式（不贴空白）原样保留", () => {
    const tree = root([
      { type: "inlineMath", value: "b" },
      { type: "inlineMath", value: "x^2 + 1" },
    ]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[0]?.type, "inlineMath");
    deepStrictEqual(tree.children?.[0]?.children?.[1]?.type, "inlineMath");
  });

  it("块级 math 不受影响——多行源码天然带换行尾，不能误伤", () => {
    const tree = root([{ type: "math", value: "a b\n" }]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[0]?.type, "math");
  });

  it("嵌套进列表/引用照常工作", () => {
    const tree: AnyNode = {
      type: "root",
      children: [
        {
          type: "list",
          children: [
            {
              type: "listItem",
              children: [
                { type: "paragraph", children: [{ type: "inlineMath", value: "5 和 " }] },
              ],
            },
          ],
        },
      ],
    };
    demoteBoundaryMath(tree);
    deepStrictEqual(
      tree.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0]?.type,
      "text",
    );
  });

  // ---- 代码/命令特征降级（2026-10：shell 命令被渲染成公式）----
  // 样本均按 remark-math 6.0.0 真实输出构造：整句
  // `… for i in $(seq 1 12); do echo '<html></html>' > x/$i.html; done`
  // 恰好配成一个行内公式，值如下

  it("shell 命令整句（含 ; 与直引号）降级回文本", () => {
    const tree = root([{ type: "inlineMath", value: "(seq 1 12); do echo '<html></html>' > x/" }]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[0], {
      type: "text",
      value: "$(seq 1 12); do echo '<html></html>' > x/$",
    });
  });

  it("echo $HOME and $PATH（尾部空白，金额同路）降级", () => {
    const tree = root([{ type: "inlineMath", value: "HOME and " }]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[0]?.type, "text");
  });

  it("$10 到 $20（尾部空白）降级", () => {
    const tree = root([{ type: "inlineMath", value: "10 到 " }]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[0]?.type, "text");
  });

  it("含 && 或 || 的值降级（shell 逻辑运算符）", () => {
    for (const value of ["cmd1 && cmd2", "a || b"]) {
      const tree = root([{ type: "inlineMath", value }]);
      demoteBoundaryMath(tree);
      deepStrictEqual(tree.children?.[0]?.children?.[0]?.type, "text");
    }
  });

  it("常见 LaTeX 不误伤：x^2 / a<b / \\frac{a}{b} / (a+b)^2", () => {
    for (const value of ["x^2", "a<b", "\\frac{a}{b}", "(a+b)^2"]) {
      const tree = root([{ type: "inlineMath", value }]);
      demoteBoundaryMath(tree);
      deepStrictEqual(tree.children?.[0]?.children?.[0]?.type, "inlineMath", value);
    }
  });

  it("LaTeX 厚空格 \\; 不降级（裸 ; 才是 shell 特征）", () => {
    const tree = root([{ type: "inlineMath", value: "x\\;y" }]);
    demoteBoundaryMath(tree);
    deepStrictEqual(tree.children?.[0]?.children?.[0]?.type, "inlineMath");
  });
});
