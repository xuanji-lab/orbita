import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { railSubviewLit, toggleRailSubview } from "./rail-subview.ts";

describe("railSubviewLit", () => {
  it("子视图正占着侧栏时点亮", () => {
    strictEqual(railSubviewLit({ overlay: null, showArchived: true }), true);
    strictEqual(railSubviewLit({ overlay: null, showArchived: false }), false);
  });

  it("设置盖着时不亮——开关在底下，但用户看不见它", () => {
    strictEqual(railSubviewLit({ overlay: "settings", showArchived: true }), false);
  });
});

describe("toggleRailSubview", () => {
  it("主列表上点开：打开子视图", () => {
    deepStrictEqual(toggleRailSubview({ overlay: null, showArchived: false }), { overlay: null, showArchived: true });
  });

  it("亮着再点一次：收起回主列表", () => {
    deepStrictEqual(toggleRailSubview({ overlay: null, showArchived: true }), { overlay: null, showArchived: false });
  });

  it("设置页里点：退出设置并打开（底下开着的也是回到它，而不是把它悄悄翻关）", () => {
    deepStrictEqual(toggleRailSubview({ overlay: "settings", showArchived: false }), { overlay: null, showArchived: true });
    deepStrictEqual(toggleRailSubview({ overlay: "settings", showArchived: true }), { overlay: null, showArchived: true });
  });
});
