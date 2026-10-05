import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { headIconKind, statusLine, summarizeInstances } from "./row-display.ts";
import type { McpInstanceInfo } from "@shared/mcp";

function inst(workspace: string, kind: "ready" | "failed" | "idle" | "connecting"): McpInstanceInfo {
  const status: McpInstanceInfo["status"] =
    kind === "ready"
      ? { kind: "ready", tools: ["a", "b"] }
      : kind === "failed"
        ? { kind: "failed", message: "boom" }
        : { kind };
  return { workspace, label: `C:/${workspace}`, status };
}

describe("summarizeInstances / headIconKind / statusLine", () => {
  test("部分失败：红三角穿透合并状态的就绪", () => {
    const summary = summarizeInstances([inst("paper3", "ready"), inst("写稿", "failed")]);
    assert.deepEqual(summary, { total: 2, ready: 1, failed: ["写稿"] });
    // 合并状态取最优 = ready——头行图标必须按失败画
    assert.equal(headIconKind({ kind: "ready", tools: ["a"] }, summary), "failed");
    const line = statusLine(summary);
    assert.equal(line?.ready, 1);
    assert.equal(line?.total, 2);
    assert.deepEqual(line?.failed, ["写稿"]);
  });

  test("全就绪：图标照旧，状态行是 n/n", () => {
    const summary = summarizeInstances([inst("paper3", "ready"), inst("写稿", "ready")]);
    assert.equal(headIconKind({ kind: "ready", tools: ["a"] }, summary), "ready");
    assert.deepEqual(statusLine(summary), { total: 2, ready: 2, failed: [] });
  });

  test("没有实例：状态行不显示（头行归「还没连上」）", () => {
    const summary = summarizeInstances([]);
    assert.equal(statusLine(summary), null);
  });

  test("全灭：状态行不重复，卡片的错误块接管", () => {
    const summary = summarizeInstances([inst("paper3", "failed"), inst("写稿", "failed")]);
    assert.equal(statusLine(summary), null);
    assert.equal(headIconKind({ kind: "failed", message: "x" }, summary), "failed");
  });

  test("一个在连一个就绪：状态行给进度（1/2），不算失败", () => {
    const summary = summarizeInstances([inst("paper3", "ready"), inst("写稿", "connecting")]);
    assert.equal(headIconKind({ kind: "ready", tools: [] }, summary), "ready");
    assert.deepEqual(statusLine(summary), { total: 2, ready: 1, failed: [] });
  });
});
