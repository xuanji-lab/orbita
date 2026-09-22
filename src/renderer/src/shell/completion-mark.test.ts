import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { nextCompletion } from "./completion-mark.ts";

describe("nextCompletion", () => {
  it("未完成的点一下就是完成", () => {
    strictEqual(nextCompletion("open"), "done");
  });

  it("已完成的再点一下是 Reopen", () => {
    strictEqual(nextCompletion("done"), "open");
  });

  it("带遗留事项的完成态同样回 open（边界：两个完成档共用一个出口）", () => {
    strictEqual(nextCompletion("done_with_todos"), "open");
  });
});
