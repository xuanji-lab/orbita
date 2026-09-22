import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldExitSubview } from "./subview-exit.ts";

describe("shouldExitSubview", () => {
  it("Archived 视图里最后一条被 unarchive 之后自动退回主列表", () => {
    strictEqual(shouldExitSubview(true, 0), true);
  });

  it("Carryovers 面板清空后同样退回主列表（第二个消费者，同一口径）", () => {
    strictEqual(shouldExitSubview(true, 0), true);
  });

  it("还有内容就留在视图里", () => {
    strictEqual(shouldExitSubview(true, 3), false);
  });

  it("不在子视图时，计数为空也不触发退出（边界：别去改主列表的状态）", () => {
    strictEqual(shouldExitSubview(false, 0), false);
  });
});
