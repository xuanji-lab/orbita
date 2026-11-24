import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveSidebarFilters } from "./sidebar-filters.ts";

const VALUES = { starredOnly: false, ageDays: null } as const;

describe("effectiveSidebarFilters", () => {
  it("默认两值 = 不过滤", () => {
    deepStrictEqual(effectiveSidebarFilters(VALUES), null);
  });

  it("任一筛选激活即生效，原样带回", () => {
    deepStrictEqual(effectiveSidebarFilters({ ...VALUES, starredOnly: true }), { ...VALUES, starredOnly: true });
    for (const ageDays of [1, 3, 5, 7] as const) {
      deepStrictEqual(effectiveSidebarFilters({ ...VALUES, ageDays }), { ...VALUES, ageDays });
    }
  });
});
