import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appIconGrid, sizedSvg } from "./app-icon-render.ts";

describe("应用图标网格", () => {
  test("macOS：512 画布里 412 的圆角卡居中，圆角 ≈ 93，带投影（1024 基准 824 / 186.7）", () => {
    const grid = appIconGrid("darwin", 512);
    assert.equal(grid.side, 412);
    assert.equal(grid.inset, 50);
    assert.equal(grid.inset * 2 + grid.side, 512);
    assert.ok(Math.abs(grid.radius - 93.35) < 0.01);
    assert.deepEqual(grid.shadow, { blur: 12, offsetY: 5, alpha: 0.28 });
  });

  test("网格随画布等比：1024 时就是 100 / 824", () => {
    const grid = appIconGrid("darwin", 1024);
    assert.equal(grid.inset, 100);
    assert.equal(grid.side, 824);
  });

  test("Windows / Linux：满铺方形，无圆角无投影", () => {
    for (const platform of ["win32", "linux", ""]) {
      assert.deepEqual(appIconGrid(platform, 512), { inset: 0, side: 512, radius: 0, shadow: null });
    }
  });

  test("sizedSvg 只给根 <svg> 补宽高", () => {
    const out = sizedSvg('<svg xmlns="x" viewBox="0 0 100 100"><svg viewBox="0 0 1 1"/></svg>', 512);
    assert.ok(out.startsWith('<svg width="512" height="512" xmlns="x"'));
    assert.equal(out.match(/width="512"/g)?.length, 1);
  });
});
