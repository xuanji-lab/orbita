/**
 * 「在右栏查看」的 focus 是一次性的（结构守卫）。
 *
 * 2026-11-06 用户报：在一条会话里点过某条自动化的「在右栏查看」后，之后不管在哪个会话点右栏的
 * 自动化，都直接进那一条的详情。根因：App 的 automationFocus 从不清空；面板随右栏关闭卸载、再次
 * 挂载时 effect 照旧拿到同一个 focus，又把详情打开一遍。修法是面板用掉 focus 就回调 App 清回 null。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(here, path), "utf8");

describe("自动化面板的 focus 用完即清", () => {
  it("面板在打开详情的那个 effect 里回调 onFocusConsumed", () => {
    const panel = read("AutomationPanel.tsx");
    assert.match(panel, /onFocusConsumed: \(\) => void;/);
    assert.match(panel, /if \(props\.focus === null\) return;[\s\S]{0,200}props\.onFocusConsumed\(\);/);
  });

  it("App 把 focus 清回 null", () => {
    const app = read("../../App.tsx");
    assert.match(app, /focus=\{automationFocus\}\s*onFocusConsumed=\{\(\) => setAutomationFocus\(null\)\}/);
  });
});
