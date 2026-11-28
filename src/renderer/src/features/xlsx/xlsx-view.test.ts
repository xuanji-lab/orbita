/**
 * Excel 底部只留一个「保存」（结构守卫，2026-11-22 验收）。
 *
 * 本仓的测试是 `node --test`，没有 jsdom / 组件渲染（`src/**` 里没有 RTL），所以这条
 * 规矩只能在源码结构上钉：保存按钮只有底栏那一个主操作位，改动清单区只有「撤销」与
 * 改动条目；两处「撤销」绑定的是同一个 `undoAll`，不再各写一份 `applyEdit(clearPending)`。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const view = readFileSync(join(here, "XlsxView.tsx"), "utf8");

const count = (source: string, needle: string): number => source.split(needle).length - 1;

describe("Excel 的「保存」只有一个入口", () => {
  it("标签为「保存」的按钮只在底栏出现一次", () => {
    // `{t.files.xlsxSave}` 是按钮文案；xlsxSaveAll / xlsxSaveFailed 等不匹配
    assert.equal(count(view, "{t.files.xlsxSave}"), 1);
  });

  it("改动清单区没有保存动作（只有撤销与条目）", () => {
    const start = view.indexOf("function XlsxPendingPanel");
    const end = view.indexOf("function XlsxFooter");
    assert.ok(start > 0 && end > start, "找不到改动清单 / 底栏两个组件");
    const pending = view.slice(start, end);
    assert.ok(!pending.includes("xlsxSave"), "改动清单区又出现了保存");
    assert.ok(!pending.includes("onSave"), "改动清单区又接了一个保存动作");
  });

  it("两处「撤销」绑同一个动作，`applyEdit(clearPending)` 只有一份", () => {
    assert.equal(count(view, "applyEdit(clearPending)"), 1);
    assert.match(view, /onClearAll=\{undoAll\}/);
    assert.match(view, /onUndoAll=\{undoAll\}/);
  });
});
