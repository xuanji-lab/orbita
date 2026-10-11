import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveSidebarFilters } from "./sidebar-filters.ts";

const VALUES = { status: "all", starredOnly: false, hasTodosOnly: false } as const;

describe("effectiveSidebarFilters（会话生命周期开关下的侧栏筛选）", () => {
  it("开关关闭：一律不过滤——残留的本地筛选状态也归零（筛选行不渲染，旧选择不该继续藏会话）", () => {
    deepStrictEqual(effectiveSidebarFilters(false, VALUES), null);
    deepStrictEqual(
      effectiveSidebarFilters(false, { status: "done", starredOnly: true, hasTodosOnly: true }),
      null,
    );
  });

  it("开关开着：默认三值 = 不过滤", () => {
    deepStrictEqual(effectiveSidebarFilters(true, VALUES), null);
  });

  it("开关开着：任一筛选激活即生效，原样带回", () => {
    deepStrictEqual(effectiveSidebarFilters(true, { ...VALUES, status: "done" }), {
      ...VALUES,
      status: "done",
    });
    deepStrictEqual(effectiveSidebarFilters(true, { ...VALUES, starredOnly: true }), {
      ...VALUES,
      starredOnly: true,
    });
    deepStrictEqual(effectiveSidebarFilters(true, { ...VALUES, hasTodosOnly: true }), {
      ...VALUES,
      hasTodosOnly: true,
    });
  });
});
