import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveSidebarFilters } from "./sidebar-filters.ts";

const VALUES = { status: "all", starredOnly: false, hasTodosOnly: false, ageDays: null } as const;

describe("effectiveSidebarFilters", () => {
  it("默认四值 = 不过滤", () => {
    deepStrictEqual(effectiveSidebarFilters(VALUES), null);
  });

  it("任一筛选激活即生效，原样带回", () => {
    deepStrictEqual(effectiveSidebarFilters({ ...VALUES, status: "done" }), { ...VALUES, status: "done" });
    deepStrictEqual(effectiveSidebarFilters({ ...VALUES, starredOnly: true }), { ...VALUES, starredOnly: true });
    deepStrictEqual(effectiveSidebarFilters({ ...VALUES, hasTodosOnly: true }), { ...VALUES, hasTodosOnly: true });
    for (const ageDays of [1, 3, 5, 7] as const) {
      deepStrictEqual(effectiveSidebarFilters({ ...VALUES, ageDays }), { ...VALUES, ageDays });
    }
  });
});
