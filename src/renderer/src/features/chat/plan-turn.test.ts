import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PlanNotice, PlanTimeline, PlanVersion } from "../context/plan-timeline.ts";
import { planTurnState } from "./plan-turn.ts";

function version(n: number, toolCallId: string): PlanVersion {
  return {
    n,
    recordId: `r${n}`,
    toolCallId,
    at: n,
    items: [
      { id: "a", text: "读代码", status: n > 1 ? "done" : "in_progress", note: null },
      { id: "b", text: "改代码", status: n > 1 ? "in_progress" : "pending", note: null },
    ],
    why: null,
    later: [],
    changes: [],
    waits: [],
    removed: [],
    awaiting: false,
  } as PlanVersion;
}

const timeline: PlanTimeline = { versions: [version(1, "p1"), version(2, "p2"), version(3, "p3")], current: version(3, "p3"), edits: 1 };
const notice: PlanNotice = { changes: [{ kind: "added", text: "加测试" }], why: "测试红了" };

describe("planTurnState：开头那张计划卡出不出、出哪种", () => {
  test("这一块里第一次写计划：定了计划（取这一块里最后一版）", () => {
    assert.deepEqual(planTurnState(timeline, null, ["p1", "p2"]), { kind: "fresh", version: timeline.versions[1] });
  });
  test("改了结构：计划改了", () => {
    assert.equal(planTurnState(timeline, notice, ["p3"])?.kind, "changed");
  });
  test("只打勾：不出卡；这一块没有计划调用：不出", () => {
    assert.equal(planTurnState(timeline, null, ["p3"]), null);
    assert.equal(planTurnState(timeline, null, []), null);
    assert.equal(planTurnState(null, notice, ["p3"]), null);
  });
});
