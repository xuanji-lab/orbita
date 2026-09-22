import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldExitArchived } from "./archived-view.ts";

describe("shouldExitArchived", () => {
  it("Archived 视图里最后一条被 unarchive 之后自动退回主列表", () => {
    strictEqual(shouldExitArchived(true, 0), true);
  });

  it("还有归档会话就留在视图里", () => {
    strictEqual(shouldExitArchived(true, 3), false);
  });

  it("不在 Archived 视图时，归档为空也不触发退出（边界：别去改主列表的状态）", () => {
    strictEqual(shouldExitArchived(false, 0), false);
  });
});
