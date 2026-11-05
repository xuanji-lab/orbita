import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultDetailTab, detailTabs, resolveDetailTab, stepDetailTab } from "./detail-tabs.ts";

describe("detailTabs：有面板的插件三页，没面板两页，旧技能 / MCP 不分页", () => {
  test("顺序固定：面板 / 工作流 / 设置与来源", () => {
    assert.deepEqual(detailTabs({ isPlugin: true, hasPanel: true }), ["panel", "workflow", "settings"]);
    assert.deepEqual(detailTabs({ isPlugin: true, hasPanel: false }), ["workflow", "settings"]);
    assert.deepEqual(detailTabs({ isPlugin: false, hasPanel: false }), []);
    assert.deepEqual(detailTabs({ isPlugin: false, hasPanel: true }), [], "旧技能 / MCP 不会有面板，真有也不分页");
  });
});

describe("默认选中：有面板就是面板，没有就是工作流", () => {
  test("defaultDetailTab", () => {
    assert.equal(defaultDetailTab(detailTabs({ isPlugin: true, hasPanel: true })), "panel");
    assert.equal(defaultDetailTab(detailTabs({ isPlugin: true, hasPanel: false })), "workflow");
    assert.equal(defaultDetailTab([]), null);
  });

  test("resolveDetailTab：想要的页签存在就用；不存在（没有面板却要面板）退回默认", () => {
    const withPanel = detailTabs({ isPlugin: true, hasPanel: true });
    const without = detailTabs({ isPlugin: true, hasPanel: false });
    assert.equal(resolveDetailTab(withPanel, null), "panel");
    assert.equal(resolveDetailTab(withPanel, "settings"), "settings");
    assert.equal(resolveDetailTab(without, "panel"), "workflow", "面板声明被删了：别停在一个不存在的页签上");
    assert.equal(resolveDetailTab(without, "settings"), "settings");
    assert.equal(resolveDetailTab([], "panel"), null);
  });
});

describe("方向键切页签", () => {
  const tabs = detailTabs({ isPlugin: true, hasPanel: true });
  test("循环；当前不在页签里从第一个起；没有页签返回 null", () => {
    assert.equal(stepDetailTab(tabs, "panel", 1), "workflow");
    assert.equal(stepDetailTab(tabs, "settings", 1), "panel");
    assert.equal(stepDetailTab(tabs, "panel", -1), "settings");
    assert.equal(stepDetailTab(tabs, null, 1), "panel");
    assert.equal(stepDetailTab([], "panel", 1), null);
  });
});
