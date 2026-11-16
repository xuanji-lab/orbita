import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clock, pendingResume, resumeLine } from "./main-resume.ts";

describe("主智能体「断过」那一行", () => {
  const r = (at: number) => ({ at, from: at - 1000, resumed: ["a", "b"], stopped: [] });
  test("只画最近一次，且你回来后还没说过话", () => {
    assert.equal(pendingResume(undefined, 0), null);
    assert.equal(pendingResume([], 0), null);
    assert.deepEqual(pendingResume([r(10), r(20)], 15), r(20));
    assert.equal(pendingResume([r(10), r(20)], 25), null);
  });
  test("同一天只写时刻，跨天带日期；文案拿到起止与件数", () => {
    const now = new Date(2026, 10, 17, 9, 0).getTime();
    assert.equal(clock(new Date(2026, 10, 17, 8, 5).getTime(), now), "08:05");
    assert.equal(clock(new Date(2026, 10, 16, 23, 41).getTime(), now), "11-16 23:41");
    const seen: unknown[] = [];
    resumeLine({ at: now, from: now - 60_000, resumed: ["a"], stopped: ["b", "c"] }, now, { line: (...args) => (seen.push(...args), "") });
    assert.deepEqual(seen, ["08:59", "09:00", 1, 2]);
  });
});
