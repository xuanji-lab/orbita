import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import { AgentEventTap, SessionPhases } from "./run-state.ts";

describe("SessionPhases：按 phase 事件维护的活会话状态", () => {
  test("没记录 = 没在跑；idle 不算在跑；别的档都算", () => {
    const phases = new SessionPhases();
    assert.equal(phases.isRunning("a"), false);
    phases.set("a", "idle");
    assert.equal(phases.isRunning("a"), false);
    for (const phase of ["turn", "compaction", "retry", "branch_summary"] as const satisfies readonly SessionPhase[]) {
      phases.set("a", phase);
      assert.equal(phases.isRunning("a"), true, phase);
    }
  });

  test("它就是那张 Map：派出子会话时先占坑写 turn、终止后删，别处的写入手机侧照样看得到", () => {
    const phases = new SessionPhases();
    const asMap: Map<string, SessionPhase> = phases;
    asMap.set("child", "turn");
    assert.equal(phases.isRunning("child"), true);
    asMap.delete("child");
    assert.equal(phases.isRunning("child"), false);
    asMap.set("x", "turn");
    asMap.set("y", "idle");
    asMap.set("z", "compaction");
    assert.deepEqual(phases.runningIds(), ["x", "z"]);
    phases.clear();
    assert.deepEqual(phases.runningIds(), []);
  });
});

describe("AgentEventTap：事件泵的订阅点", () => {
  test("按订阅顺序同步通知；订阅了就不退", () => {
    const tap = new AgentEventTap();
    const order: string[] = [];
    tap.subscribe((event) => order.push(`一:${event.type}`));
    tap.subscribe((event) => order.push(`二:${event.type}`));
    tap.emit({ type: "ready" });
    tap.emit({ type: "phase", sessionId: "s", phase: "idle" });
    assert.deepEqual(order, ["一:ready", "二:ready", "一:phase", "二:phase"]);
  });

  test("一个旁听者出错不拖累别的，也不把错抛回事件泵", () => {
    const tap = new AgentEventTap();
    const seen: string[] = [];
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      tap.subscribe(() => {
        throw new Error("旁听者炸了");
      });
      tap.subscribe((event) => void seen.push(event.type));
      assert.doesNotThrow(() => tap.emit({ type: "ready" }));
    } finally {
      console.error = original;
    }
    assert.deepEqual(seen, ["ready"]);
    assert.equal(errors.length, 1);
  });
});
