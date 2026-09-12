import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NEW_TASK_TAB,
  closeTab,
  dockTab,
  neighborTab,
  replaceNewTab,
} from "./drawer-state.ts";

describe("停靠标签", () => {
  it("dock：追加，重复 dock 不动", () => {
    deepStrictEqual(dockTab([], "a"), ["a"]);
    deepStrictEqual(dockTab(["a", "new"], "a"), ["a", "new"]);
  });
  it("close：只删自己", () => {
    deepStrictEqual(closeTab(["a", "new", "b"], "new"), ["a", "b"]);
  });
  it("replaceNewTab：新任务发出第一句后换成真 id；没有占位则不动", () => {
    deepStrictEqual(replaceNewTab(["a", NEW_TASK_TAB], "x"), ["a", "x"]);
    deepStrictEqual(replaceNewTab(["a", "b"], "x"), ["a", "b"]);
  });
  it("neighborTab：右邻优先，没有就左邻", () => {
    deepStrictEqual(neighborTab(["a", "b", "c"], "b"), "c");
    deepStrictEqual(neighborTab(["a", "b", "c"], "c"), "b");
    deepStrictEqual(neighborTab(["a"], "a"), null);
  });
  it("neighborTab：关掉不存在的标签时退到最右", () => {
    deepStrictEqual(neighborTab(["a", "b"], "zz"), "b");
    deepStrictEqual(neighborTab([], "zz"), null);
  });
});
