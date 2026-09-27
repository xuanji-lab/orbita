import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { railSubviewLit, toggleRailSubview } from "./rail-subview.ts";

describe("railSubviewLit", () => {
  it("子视图正占着侧栏时点亮", () => {
    strictEqual(
      railSubviewLit({ overlay: null, showArchived: false, showCarryovers: true }, "carryovers"),
      true,
    );
    strictEqual(
      railSubviewLit({ overlay: null, showArchived: true, showCarryovers: false }, "archived"),
      true,
    );
  });

  it("设置盖着时不亮——开关在底下，但用户看不见它", () => {
    strictEqual(
      railSubviewLit({ overlay: "settings", showArchived: false, showCarryovers: true }, "carryovers"),
      false,
    );
  });

  it("另一个子视图占着时不亮", () => {
    strictEqual(
      railSubviewLit({ overlay: null, showArchived: true, showCarryovers: false }, "carryovers"),
      false,
    );
  });
});

describe("toggleRailSubview", () => {
  it("主列表上点开：打开该子视图", () => {
    deepStrictEqual(
      toggleRailSubview({ overlay: null, showArchived: false, showCarryovers: false }, "archived"),
      { overlay: null, showArchived: true, showCarryovers: false },
    );
  });

  it("亮着再点一次：收起回主列表", () => {
    deepStrictEqual(
      toggleRailSubview({ overlay: null, showArchived: false, showCarryovers: true }, "carryovers"),
      { overlay: null, showArchived: false, showCarryovers: false },
    );
  });

  it("设置页里点没开过的子视图：退出设置并打开（修复点——以前只在底下翻转，界面不动）", () => {
    deepStrictEqual(
      toggleRailSubview({ overlay: "settings", showArchived: false, showCarryovers: false }, "archived"),
      { overlay: null, showArchived: true, showCarryovers: false },
    );
  });

  it("设置页里点底下开着的子视图：回到它，而不是把它悄悄翻关", () => {
    deepStrictEqual(
      toggleRailSubview({ overlay: "settings", showArchived: false, showCarryovers: true }, "carryovers"),
      { overlay: null, showArchived: false, showCarryovers: true },
    );
  });

  it("carryovers 开着时点 archived：直接切换（互斥，先收再开）", () => {
    deepStrictEqual(
      toggleRailSubview({ overlay: null, showArchived: false, showCarryovers: true }, "archived"),
      { overlay: null, showArchived: true, showCarryovers: false },
    );
  });
});
