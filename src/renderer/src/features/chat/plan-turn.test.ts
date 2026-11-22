import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PlanNotice, PlanStep, PlanTimeline, PlanVersion } from "../context/plan-timeline.ts";
import { planDiffLines, planDiffStats, planTurnState } from "./plan-turn.ts";

const step = (text: string, status: PlanStep["status"] = "pending"): PlanStep => ({ id: text, text, status, note: null });

function version(n: number, toolCallId: string, items: PlanStep[]): PlanVersion {
  return { n, recordId: `r-${toolCallId}`, toolCallId, at: n, items, why: null, later: [], changes: [], waits: [], removed: [], awaiting: false };
}

const v1 = version(1, "p1", [step("读代码", "in_progress"), step("改代码")]);
const v2 = version(2, "p2", [step("读代码", "done"), step("改代码", "in_progress")]);
const v3 = version(3, "p3", [step("读代码", "done"), step("改代码", "in_progress"), step("加测试")]);
const timeline: PlanTimeline = { versions: [v1, v2, v3], current: v3, edits: 1 };
const notice: PlanNotice = { changes: [{ kind: "added", text: "加测试" }], why: "测试红了" };

describe("planTurnState：开头那张计划卡出不出、出哪种", () => {
  test("这一块里第一次写计划：定了计划（取这一块里最后一版）", () => {
    assert.deepEqual(planTurnState(timeline, null, ["p1", "p2"]), { kind: "fresh", version: v2 });
  });
  test("改了结构：改了计划，带着这一块之前的那一版当 diff 的底", () => {
    const state = planTurnState(timeline, notice, ["p3"]);
    assert.equal(state?.kind, "changed");
    assert.equal(state?.kind === "changed" ? state.base : null, v2);
  });
  test("之前写过别的计划、这一块又从第 1 版起：定了新计划", () => {
    const w1 = version(1, "q1", [step("写周报", "in_progress")]);
    const t2: PlanTimeline = { versions: [v1, v2, v3, w1], current: w1, edits: 1 };
    assert.deepEqual(planTurnState(t2, null, ["q1"]), { kind: "fresh", version: w1, replaced: true });
  });
  test("整张换掉（一步都没留下）：算定了新计划，不画满屏红绿", () => {
    const v4 = version(4, "p4", [step("写周报", "in_progress"), step("导出")]);
    const t2: PlanTimeline = { versions: [v1, v2, v3, v4], current: v4, edits: 2 };
    assert.deepEqual(planTurnState(t2, notice, ["p4"]), { kind: "fresh", version: v4, replaced: true });
  });
  test("只打勾：不出卡；这一块没有计划调用：不出", () => {
    assert.equal(planTurnState(timeline, null, ["p2b"]), null);
    assert.equal(planTurnState(timeline, null, []), null);
    assert.equal(planTurnState(null, notice, ["p3"]), null);
  });
});

describe("planDiffLines：上一版 → 这一版的红绿 diff，覆盖加 / 去 / 改说法 / 挪 / 拆 / 合", () => {
  const show = (lines: ReturnType<typeof planDiffLines>) => lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
  test("加一步、打勾不算改动（那一步是 same、带新状态）", () => {
    const lines = planDiffLines(v2.items, v3.items);
    assert.deepEqual(show(lines), [" 读代码", " 改代码", "+加测试"]);
    assert.equal(lines[0]?.status, "done");
    assert.deepEqual(planDiffStats(lines), { added: 1, removed: 0 });
  });
  test("改说法：一红一绿，红在前", () => {
    assert.deepEqual(show(planDiffLines([step("A"), step("B"), step("C")], [step("A"), step("B2"), step("C")])), [" A", "-B", "+B2", " C"]);
  });
  test("挪位置：旧位置一红、新位置一绿", () => {
    assert.deepEqual(show(planDiffLines([step("A"), step("B"), step("C")], [step("C"), step("A"), step("B")])), ["+C", " A", " B", "-C"]);
  });
  test("拆成两步 / 合成一步、去掉一步", () => {
    assert.deepEqual(show(planDiffLines([step("A"), step("B")], [step("A"), step("B1"), step("B2")])), [" A", "-B", "+B1", "+B2"]);
    assert.deepEqual(show(planDiffLines([step("A"), step("B"), step("C")], [step("A")])), [" A", "-B", "-C"]);
  });
});
