import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { PIE_FRACTION, wedgePath } from "./status-pie.ts";

describe("状态饼", () => {
  it("份数与旧竖条一致：在跑 1/3、等你 2/3、跑完 / 出错满圆", () => {
    strictEqual(PIE_FRACTION.running, 1 / 3);
    strictEqual(PIE_FRACTION.waiting, 2 / 3);
    strictEqual(PIE_FRACTION.done, 1);
    strictEqual(PIE_FRACTION.failed, 1);
  });
  it("扇形过半才走大弧（2/3 的饼不能画成 1/3 的补角）", () => {
    strictEqual(wedgePath(1 / 3).includes(" 0 0 1 "), true);
    strictEqual(wedgePath(2 / 3).includes(" 0 1 1 "), true);
  });
  it("从 12 点顺时针：1/3 的终点在右下", () => {
    // 120° → x = 5 + r·sin120 ≈ 8.68，y = 5 − r·cos120 ≈ 7.12
    strictEqual(wedgePath(1 / 3).endsWith("8.68 7.12z"), true);
  });
});
