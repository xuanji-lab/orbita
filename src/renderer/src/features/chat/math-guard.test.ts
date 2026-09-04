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
});
