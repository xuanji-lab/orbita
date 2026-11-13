import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NEW_TASK_TAB,
  adoptNewTab,
  closeTab,
  dockTab,
  neighborTab,
  otherTabs,
  replaceNewTab,
  tabLabel,
  tabShortId,
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

describe("新任务拿到真 id", () => {
  it("adoptNewTab：列表里没有占位（App 存的就是这样）→ 追加到右端", () => {
    deepStrictEqual(adoptNewTab(["a", "b"], "x"), ["a", "b", "x"]);
    deepStrictEqual(adoptNewTab([], "x"), ["x"]);
  });
  it("adoptNewTab：有占位 → 原位换掉；已在列表里 → 不重复", () => {
    deepStrictEqual(adoptNewTab(["a", NEW_TASK_TAB, "b"], "x"), ["a", "x", "b"]);
    deepStrictEqual(adoptNewTab(["a", "x"], "x"), ["a", "x"]);
  });
});

describe("胶囊右段的其它标签", () => {
  it("otherTabs：拿掉激活的，其余保持停靠顺序", () => {
    deepStrictEqual(otherTabs(["a", "b", "c"], "b"), ["a", "c"]);
    deepStrictEqual(otherTabs(["a"], "a"), []);
  });
  it("otherTabs：没有激活（选择器态）= 全部；激活的不在列表里也不丢别的", () => {
    deepStrictEqual(otherTabs(["a", "b"], null), ["a", "b"]);
    deepStrictEqual(otherTabs(["a", "b"], "zz"), ["a", "b"]);
  });
  it("关标签后右段与激活一致：关激活 → 邻居上位，右段不再含它", () => {
    const docked = ["a", "b", "c"];
    const next = closeTab(docked, "b");
    const active = neighborTab(docked, "b");
    deepStrictEqual(active, "c");
    deepStrictEqual(otherTabs(next, active), ["a"]);
  });
  it("new 占位换成真 id 后，右段里的标签名跟着换", () => {
    const docked = replaceNewTab(["a", NEW_TASK_TAB], "x");
    deepStrictEqual(otherTabs(docked, "a").map((tab) => tabLabel(tab, null, "新任务")), ["x…"]);
  });
  it("tabLabel：新任务占位用固定文案，落盘会话取标题，查不到标题退回 id 前 6 位", () => {
    deepStrictEqual(tabLabel(NEW_TASK_TAB, null, "新任务"), "新任务");
    deepStrictEqual(tabLabel("abcdef123456", "查看论文", "新任务"), "查看论文");
    deepStrictEqual(tabLabel("abcdef123456", null, "新任务"), "abcdef…");
  });
  it("tabShortId：与主会话胶囊同取前 6 位；新任务占位还没有 id", () => {
    deepStrictEqual(tabShortId("abcdef123456"), "abcdef");
    deepStrictEqual(tabShortId(NEW_TASK_TAB), null);
  });
});
