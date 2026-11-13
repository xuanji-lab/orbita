import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpPanelUsage, isPanelUsageKey, PANEL_USAGE_KEYS, panelUsageRows, parsePanelUsage } from "./panel-usage.ts";

describe("parsePanelUsage —— 读盘当不可信数据", () => {
  it("不在 / 坏了：从 now 重新数", () => {
    deepStrictEqual(parsePanelUsage(null, 5), { since: 5, counts: {} });
    deepStrictEqual(parsePanelUsage("x", 5), { since: 5, counts: {} });
    deepStrictEqual(parsePanelUsage({ since: -1, counts: { task: 3 } }, 5), { since: 5, counts: {} });
    deepStrictEqual(parsePanelUsage({ counts: { task: 3 } }, 5), { since: 5, counts: {} });
  });

  it("认不出的键、非正整数的计数丢掉，其余原样", () => {
    deepStrictEqual(
      parsePanelUsage({ since: 100, counts: { task: 3, review: 0, files: 1.5, bogus: 9, bell: -2, terminal: 7 } }, 5),
      { since: 100, counts: { task: 3, terminal: 7 } },
    );
  });
});

describe("bumpPanelUsage / panelUsageRows", () => {
  it("记一次不改入参；没记过的从 1 开始", () => {
    const start = { since: 1, counts: { task: 2 } };
    const next = bumpPanelUsage(bumpPanelUsage(start, "task"), "review");
    deepStrictEqual(next, { since: 1, counts: { task: 3, review: 1 } });
    deepStrictEqual(start, { since: 1, counts: { task: 2 } });
  });

  it("统计行：全部面板都列（0 次也列），多的在前，同票按登记顺序", () => {
    const rows = panelUsageRows({ since: 1, counts: { review: 2, terminal: 5, bell: 2 } });
    strictEqual(rows.length, PANEL_USAGE_KEYS.length);
    deepStrictEqual(rows.slice(0, 4), [
      { key: "terminal", count: 5 },
      { key: "review", count: 2 },
      { key: "bell", count: 2 },
      { key: "task", count: 0 },
    ]);
  });

  it("isPanelUsageKey 只认登记过的键", () => {
    strictEqual(isPanelUsageKey("task"), true);
    strictEqual(isPanelUsageKey("bogus"), false);
    for (const key of ["plugins", "automation", "board", "settings", "memory"]) strictEqual(isPanelUsageKey(key), true, key);
    strictEqual(isPanelUsageKey(3), false);
  });
});
