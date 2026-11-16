import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clock, placeResumes, resumeLine } from "./main-resume.ts";

describe("主智能体「断过」那一行", () => {
  const r = (at: number) => ({ at, from: at - 1000, resumed: ["a", "b"], stopped: [] });
  test("按时间插在之后的第一条用户消息前；之后没人说话的放末尾；都留着", () => {
    assert.equal(placeResumes(undefined, []).atEnd.length, 0);
    const users = [{ id: "u1", timestamp: 5 }, { id: "u2", timestamp: 15 }];
    const placed = placeResumes([r(20), r(10), r(12)], users);
    assert.deepEqual(placed.beforeUser.get("u2"), [r(10), r(12)]);
    assert.equal(placed.beforeUser.has("u1"), false);
    assert.deepEqual(placed.atEnd, [r(20)]);
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
