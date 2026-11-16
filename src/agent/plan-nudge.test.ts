import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NUDGE_AFTER, NUDGE_MAX_PER_TURN, PlanNudge, planIsActive } from "./plan-nudge.ts";
import type { PlanItem } from "../shared/plan.ts";

const active: PlanItem[] = [
  { text: "读代码", status: "done" },
  { text: "改实现", status: "in_progress" },
];
const finished: PlanItem[] = [{ text: "读代码", status: "done" }];

function run(nudge: PlanNudge, calls: number, plan: PlanItem[] | null, name = "bash"): (string | null)[] {
  return Array.from({ length: calls }, () => nudge.afterTool(name, () => plan));
}

describe("PlanNudge：连续若干次工具调用没动计划才提醒", () => {
  it("第 NUDGE_AFTER 次提醒一次、从零重数；同一轮最多 NUDGE_MAX_PER_TURN 次", () => {
    const nudge = new PlanNudge();
    const out = run(nudge, NUDGE_AFTER * (NUDGE_MAX_PER_TURN + 2), active);
    const hits = out.flatMap((text, index) => (text === null ? [] : [index + 1]));
    assert.deepEqual(hits, Array.from({ length: NUDGE_MAX_PER_TURN }, (_, i) => NUDGE_AFTER * (i + 1)));
    assert.match(out[NUDGE_AFTER - 1] ?? "", /12 tool calls since you last updated the plan/);
  });
  it("调了 update_plan 就从零重数", () => {
    const nudge = new PlanNudge();
    run(nudge, NUDGE_AFTER - 1, active);
    assert.equal(nudge.afterTool("update_plan", () => active), null);
    assert.ok(run(nudge, NUDGE_AFTER - 1, active).every((text) => text === null));
    assert.notEqual(nudge.afterTool("read", () => active), null);
  });
  it("没有计划（一问一答）或计划全做完：不提醒", () => {
    assert.ok(run(new PlanNudge(), NUDGE_AFTER * 2, null).every((text) => text === null));
    assert.ok(run(new PlanNudge(), NUDGE_AFTER * 2, finished).every((text) => text === null));
    assert.equal(planIsActive([{ text: "等你", status: "waiting" }]), true);
  });
  it("这次结果附不了（输出缺席）：不提醒、不清零，下一次能附时补上", () => {
    const nudge = new PlanNudge();
    run(nudge, NUDGE_AFTER - 1, active);
    assert.equal(nudge.afterTool("bash", () => active, false), null);
    assert.match(nudge.afterTool("bash", () => active) ?? "", /13 tool calls/);
  });
});
