import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { headIconKind, mcpErrors, namedInstances, readyWorkspaces, statusLine, summarizeInstances } from "./mcp-row-display.ts";
import type { McpInstanceInfo } from "@shared/mcp";

function inst(workspace: string, kind: "ready" | "failed" | "idle" | "connecting" | "disabled"): McpInstanceInfo {
  const status: McpInstanceInfo["status"] =
    kind === "ready"
      ? { kind: "ready", tools: ["a", "b"] }
      : kind === "failed"
        ? { kind: "failed", message: "boom" }
        : { kind };
  return { scope: `id-${workspace}`, workspace, label: `C:/${workspace}`, status };
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

  test("停用的实例不计入就绪率：「不该就绪」不是「没就绪」", () => {
    // PR #164 评审：disabled 的 server 显示成「0/1 个工作区就绪」，像一个故障——它是用户自己关的
    const only = summarizeInstances([inst("paper3", "disabled")]);
    assert.deepEqual(only, { total: 0, ready: 0, failed: [] });
    assert.equal(statusLine(only), null);
    const mixed = summarizeInstances([inst("paper3", "ready"), inst("写稿", "disabled")]);
    assert.deepEqual(statusLine(mixed), { total: 1, ready: 1, failed: [] });
  });
});

describe("readyWorkspaces / mcpErrors", () => {
  test("就绪的工作区名按实例顺序", () => {
    assert.deepEqual(readyWorkspaces([inst("a", "ready"), inst("b", "failed"), inst("c", "ready")]), ["a", "c"]);
    assert.deepEqual(readyWorkspaces([]), []);
  });

  test("整台失败 + 单个实例同一段原文：只出一条，不标工作区", () => {
    const failed = { kind: "failed" as const, message: "spawn ENOENT" };
    const only = { ...inst("paper-a", "failed"), status: failed };
    assert.deepEqual(mcpErrors(failed, [only]), [{ workspaces: [], message: "spawn ENOENT" }]);
    assert.deepEqual(mcpErrors(failed, []), [{ workspaces: [], message: "spawn ENOENT" }]);
  });

  test("多个实例：相同原文合并成一条并列出工作区，不同原文各一条；就绪的实例不产生错误", () => {
    const f = (workspace: string, message: string): McpInstanceInfo => ({ ...inst(workspace, "failed"), status: { kind: "failed", message } });
    const errors = mcpErrors({ kind: "ready", tools: ["a"] }, [f("a", "boom"), f("b", "boom"), f("c", "other"), inst("d", "ready")]);
    assert.deepEqual(errors, [
      { workspaces: ["a", "b"], message: "boom" },
      { workspaces: ["c"], message: "other" },
    ]);
  });

  test("没有失败：空数组", () => {
    assert.deepEqual(mcpErrors({ kind: "ready", tools: [] }, [inst("a", "ready")]), []);
    assert.deepEqual(mcpErrors({ kind: "idle" }, []), []);
  });
});

describe("namedInstances", () => {
  test("补上工作区名、丢掉 Home 实例、翻不到的原样用 id", () => {
    const status = { kind: "ready" as const, tools: ["a"] };
    const named = namedInstances(
      [
        { scope: "", label: "", status },
        { scope: "ws-1", label: "/p/a", status },
        { scope: "gone", label: "/p/b", status },
      ],
      (id) => (id === "ws-1" ? "paper-a" : id),
    );
    assert.deepEqual(named.map((each) => [each.scope, each.workspace]), [["ws-1", "paper-a"], ["gone", "gone"]]);
  });
});
