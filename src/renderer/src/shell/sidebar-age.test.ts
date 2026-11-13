import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ageCounts, filterByAge, withinAge } from "./sidebar-age.ts";
import { DAY_MS } from "./relative-time.ts";

const NOW = Date.UTC(2026, 10, 7, 6, 50);
const ago = (days: number, extraMs = 0): number => NOW - days * DAY_MS - extraMs;
const mk = (id: string, updatedAt: number) => ({ id, updatedAt });

describe("withinAge", () => {
  it("不限恒真；N 天含边界（恰好 N×24 小时前仍在），多 1 毫秒就出去", () => {
    strictEqual(withinAge(ago(400), NOW, null), true);
    strictEqual(withinAge(ago(3), NOW, 3), true);
    strictEqual(withinAge(ago(3, 1), NOW, 3), false);
    strictEqual(withinAge(NOW, NOW, 1), true);
    // 未来时间（时钟漂移）算在窗口里
    strictEqual(withinAge(NOW + 60_000, NOW, 1), true);
  });
});

describe("filterByAge", () => {
  const list = [mk("a", ago(0.1)), mk("b", ago(2)), mk("c", ago(6)), mk("d", ago(30))];

  it("不限原样返回同一个数组", () => {
    strictEqual(filterByAge(list, NOW, null, null), list);
  });

  it("保留窗口内的，顺序不变，不截条数", () => {
    deepStrictEqual(filterByAge(list, NOW, 3, null).map((m) => m.id), ["a", "b"]);
    deepStrictEqual(filterByAge(list, NOW, 7, null).map((m) => m.id), ["a", "b", "c"]);
    const many = Array.from({ length: 40 }, (_, i) => mk(`m${i}`, ago(0.5)));
    strictEqual(filterByAge(many, NOW, 1, null).length, 40);
  });

  it("正在看的那条即使出了窗口也留着，位置不变", () => {
    deepStrictEqual(filterByAge(list, NOW, 1, "d").map((m) => m.id), ["a", "d"]);
    deepStrictEqual(filterByAge(list, NOW, 1, "b").map((m) => m.id), ["a", "b"]);
  });

  it("openId 不在列表里没有副作用", () => {
    deepStrictEqual(filterByAge(list, NOW, 1, "zzz").map((m) => m.id), ["a"]);
  });
});

describe("ageCounts", () => {
  it("每档是命中条数，不限是总数，且单调不减", () => {
    const list = [mk("a", ago(0.1)), mk("b", ago(0.9)), mk("c", ago(2)), mk("d", ago(4)), mk("e", ago(6)), mk("f", ago(30))];
    deepStrictEqual(ageCounts(list, NOW), { 1: 2, 3: 3, 5: 4, 7: 5, any: 6 });
  });

  it("空列表全 0", () => {
    deepStrictEqual(ageCounts([], NOW), { 1: 0, 3: 0, 5: 0, 7: 0, any: 0 });
  });
});
