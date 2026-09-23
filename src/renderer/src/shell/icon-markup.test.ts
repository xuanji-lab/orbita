import { notStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { iconMarkup } from "./icon-markup.ts";

describe("iconMarkup", () => {
  it("同名两次调用返回同一个对象引用——React 的身份比较不再判定成「变了」", () => {
    const first = iconMarkup("markup-test-a", () => "<svg>a</svg>");
    const second = iconMarkup("markup-test-a", () => "<svg>a</svg>");
    strictEqual(first, second);
  });

  it("不同名返回不同对象", () => {
    const a = iconMarkup("markup-test-b1", () => "<svg>b1</svg>");
    const b = iconMarkup("markup-test-b2", () => "<svg>b2</svg>");
    notStrictEqual(a, b);
  });

  it("命中缓存后不再调用 buildHtml——只在第一次真的构建", () => {
    let calls = 0;
    iconMarkup("markup-test-c", () => {
      calls += 1;
      return "<svg>c</svg>";
    });
    iconMarkup("markup-test-c", () => {
      calls += 1;
      return "<svg>c</svg>";
    });
    strictEqual(calls, 1);
  });

  it("缓存的 __html 就是 buildHtml 第一次算出来的那个值", () => {
    const result = iconMarkup("markup-test-d", () => "<svg>d</svg>");
    strictEqual(result.__html, "<svg>d</svg>");
  });
});
