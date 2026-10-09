import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TASKS_FOLD_KEY,
  defaultGroupFolded,
  foldKeyForWorkspace,
  isGroupFolded,
  toggleGroupFold,
  toggleGroupFull,
  unfoldGroup,
  type SidebarGroupState,
} from "./sidebar-fold.ts";

const empty = (): SidebarGroupState => ({ overrides: new Set<string>(), full: new Set<string>() });

describe("默认折叠态", () => {
  it("工作区组默认折叠（只留组头），TASKS 默认展开", () => {
    deepStrictEqual(isGroupFolded(empty(), foldKeyForWorkspace("a")), true);
    deepStrictEqual(isGroupFolded(empty(), TASKS_FOLD_KEY), false);
    deepStrictEqual(defaultGroupFolded(foldKeyForWorkspace("a")), true);
    deepStrictEqual(defaultGroupFolded(TASKS_FOLD_KEY), false);
  });
});

describe("toggleGroupFold", () => {
  it("默认展开的组折起记 override，再翻一次归位（正常路径）", () => {
    const folded = toggleGroupFold(empty(), TASKS_FOLD_KEY);
    deepStrictEqual(isGroupFolded(folded, TASKS_FOLD_KEY), true);
    const reopened = toggleGroupFold(folded, TASKS_FOLD_KEY);
    deepStrictEqual(isGroupFolded(reopened, TASKS_FOLD_KEY), false);
    // 归位后不留 override——回到默认态的 key 不该在集合里占着
    deepStrictEqual(reopened.overrides.has(TASKS_FOLD_KEY), false);
  });

  it("默认折叠的工作区组翻一次就展开", () => {
    const opened = toggleGroupFold(empty(), "workspace:a");
    deepStrictEqual(isGroupFolded(opened, "workspace:a"), false);
    const refolded = toggleGroupFold(opened, "workspace:a");
    deepStrictEqual(isGroupFolded(refolded, "workspace:a"), true);
    deepStrictEqual(refolded.overrides.has("workspace:a"), false);
  });

  it("折叠时清掉「全部显示」——重开回到默认预览，折叠才算归位", () => {
    const opened = toggleGroupFold(empty(), "workspace:a");
    const expanded = toggleGroupFull(opened, "workspace:a");
    const folded = toggleGroupFold(expanded, "workspace:a");
    deepStrictEqual(folded.full.has("workspace:a"), false);
  });

  it("展开不动「全部显示」——点过 Show more 的组加新任务，列不变回预览", () => {
    const expanded = toggleGroupFull(empty(), "workspace:a");
    const unfolded = unfoldGroup(expanded, "workspace:a");
    deepStrictEqual(unfolded.full.has("workspace:a"), true);
  });

  it("不改动原状态——React 靠新引用才知道要重渲染", () => {
    const original = empty();
    const next = toggleGroupFold(original, TASKS_FOLD_KEY);
    deepStrictEqual(original.overrides.has(TASKS_FOLD_KEY), false);
    deepStrictEqual(next.overrides.has(TASKS_FOLD_KEY), true);
  });
});

describe("toggleGroupFull", () => {
  it("Show more 铺开全组，Show less 收回最近的 N 条（双向）", () => {
    const expanded = toggleGroupFull(empty(), "workspace:a");
    deepStrictEqual(expanded.full.has("workspace:a"), true);
    const collapsed = toggleGroupFull(expanded, "workspace:a");
    deepStrictEqual(collapsed.full.has("workspace:a"), false);
  });

  it("不动折叠态——收起 Show more 不该顺带把组折了", () => {
    const folded = toggleGroupFold(empty(), TASKS_FOLD_KEY);
    const full = toggleGroupFull(folded, TASKS_FOLD_KEY);
    deepStrictEqual(isGroupFolded(full, TASKS_FOLD_KEY), true);
  });
});

describe("unfoldGroup", () => {
  it("展开默认折叠的工作区组；已经展开着的组原样返回同一引用", () => {
    const opened = unfoldGroup(empty(), "workspace:a");
    deepStrictEqual(isGroupFolded(opened, "workspace:a"), false);
    const original = empty();
    deepStrictEqual(unfoldGroup(original, TASKS_FOLD_KEY), original);
  });
});

describe("foldKeyForWorkspace", () => {
  it("带命名空间——不同工作区不串key，也不与 TASKS 的固定 key 撞车", () => {
    deepStrictEqual(foldKeyForWorkspace("a"), "workspace:a");
    deepStrictEqual(foldKeyForWorkspace(TASKS_FOLD_KEY), "workspace:tasks");
    deepStrictEqual(foldKeyForWorkspace("a") === TASKS_FOLD_KEY, false);
  });
});
