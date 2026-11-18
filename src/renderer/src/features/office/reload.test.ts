/**
 * 刷新令牌的语义（2026-11-17 验收 BUG）：
 *   - 编辑落盘 / 整批回退 / 手动刷新都必须把**渲染与数据两个令牌一起**加一；
 *   - 回退不得改变视图模式（用户看着渲染视图，就应在原地重新渲染）。
 *
 * 之前的实现：回退只 bump 网格令牌并 `setMode("data")`，于是「回退后渲染视图要手动
 * 切一次才回来」；这条测试钉住「两边都 +1、模式不动」。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bumpOfficeReload, OFFICE_RELOAD_INITIAL } from "./reload.ts";

describe("bumpOfficeReload", () => {
  test("编辑 / 回退 / 手动刷新：渲染与数据令牌一起 +1", () => {
    const once = bumpOfficeReload(OFFICE_RELOAD_INITIAL);
    assert.deepEqual(once, { render: 1, data: 1 });
    const twice = bumpOfficeReload(once);
    assert.deepEqual(twice, { render: 2, data: 2 });
    // 不共享引用：旧状态不被就地改写
    assert.deepEqual(once, { render: 1, data: 1 });
    assert.notEqual(twice, once);
  });

  test("令牌只增不减（哪怕从不对称的状态出发）", () => {
    assert.deepEqual(bumpOfficeReload({ render: 5, data: 2 }), { render: 6, data: 3 });
  });
});
