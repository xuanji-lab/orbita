import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { displayedStatus, headIconKind, statusLine, statusTextSpec, summarizeInstances } from "./row-display.ts";
import type { McpInstanceInfo, McpStatus } from "@shared/mcp";

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

describe("statusTextSpec —— 卡片头行文案的语义档", () => {
  test("ready 出工具数（不是「就绪」二字：用户要看的是会什么）", () => {
    assert.deepEqual(statusTextSpec({ kind: "ready", tools: ["a", "b"] }), { kind: "tools", count: 2 });
  });

  test("connecting 自成一档——以前它落到 notConnected，正在连看着像没连上（A8）", () => {
    assert.deepEqual(statusTextSpec({ kind: "connecting" }), { kind: "connecting" });
    assert.notDeepEqual(statusTextSpec({ kind: "connecting" }), statusTextSpec({ kind: "idle" }));
  });

  test("其余三档各自对得上", () => {
    assert.deepEqual(statusTextSpec({ kind: "failed", message: "boom" }), { kind: "failed" });
    assert.deepEqual(statusTextSpec({ kind: "disabled" }), { kind: "disabled" });
    assert.deepEqual(statusTextSpec({ kind: "idle" }), { kind: "idle" });
  });
});

describe("displayedStatus —— Reload 期间的状态换算", () => {
  const cases: McpStatus[] = [
    { kind: "idle" },
    { kind: "connecting" },
    { kind: "ready", tools: ["a"] },
    { kind: "failed", message: "boom" },
  ];

  test("reloading 时非 disabled 一律转 connecting（旧状态是谎话）", () => {
    for (const status of cases) {
      assert.equal(displayedStatus(status, true).kind, "connecting", `reloading 下 ${status.kind} 应转 connecting`);
    }
  });

  test("停用行不转：它是用户关的，重连也不连它", () => {
    assert.equal(displayedStatus({ kind: "disabled" }, true).kind, "disabled");
  });

  test("不 reload 时原样返回（引用同一对象，不该白造新对象）", () => {
    for (const status of cases) {
      assert.equal(displayedStatus(status, false), status);
    }
    const disabled: McpStatus = { kind: "disabled" };
    assert.equal(displayedStatus(disabled, false), disabled);
  });
});
