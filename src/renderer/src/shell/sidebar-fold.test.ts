import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TASKS_FOLD_KEY,
  defaultGroupFolded,
  foldKeyForWorkspace,
  isGroupFolded,
  groupVisibleLimit,
  nextPageSize,
  showLessInGroup,
  showMoreInGroup,
  toggleGroupFold,
  unfoldGroup,
  type SidebarGroupState,
} from "./sidebar-fold.ts";

const empty = (): SidebarGroupState => ({ overrides: new Set<string>(), pages: new Map<string, number>() });

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

  it("折叠时清掉 Show more 放出的页——重开回到默认预览，折叠才算归位", () => {
    const opened = toggleGroupFold(empty(), "workspace:a");
    const expanded = showMoreInGroup(showMoreInGroup(opened, "workspace:a"), "workspace:a");
    const folded = toggleGroupFold(expanded, "workspace:a");
    deepStrictEqual(folded.pages.has("workspace:a"), false);
    deepStrictEqual(groupVisibleLimit(toggleGroupFold(folded, "workspace:a"), "workspace:a"), 5);
  });

  it("展开不动 Show more 放出的页——点过 Show more 的组加新任务，列不变回预览", () => {
    const expanded = showMoreInGroup(empty(), "workspace:a");
    const unfolded = unfoldGroup(expanded, "workspace:a");
    deepStrictEqual(unfolded.pages.get("workspace:a"), 1);
  });

  it("不改动原状态——React 靠新引用才知道要重渲染", () => {
    const original = empty();
    const next = toggleGroupFold(original, TASKS_FOLD_KEY);
    deepStrictEqual(original.overrides.has(TASKS_FOLD_KEY), false);
    deepStrictEqual(next.overrides.has(TASKS_FOLD_KEY), true);
  });
});

describe("Show more / Show less", () => {
  it("工作区组默认列 5 条，每点一次 Show more 多 5 条；Show less 收回 5 条", () => {
    const key = "workspace:a";
    deepStrictEqual(groupVisibleLimit(empty(), key), 5);
    const once = showMoreInGroup(empty(), key);
    deepStrictEqual(groupVisibleLimit(once, key), 10);
    const twice = showMoreInGroup(once, key);
    deepStrictEqual(groupVisibleLimit(twice, key), 15);
    deepStrictEqual(groupVisibleLimit(showLessInGroup(twice, key), key), 5);
  });

  it("TASKS 维持原样：默认 10 条，Show more 一次放完", () => {
    deepStrictEqual(groupVisibleLimit(empty(), TASKS_FOLD_KEY), 10);
    deepStrictEqual(groupVisibleLimit(showMoreInGroup(empty(), TASKS_FOLD_KEY), TASKS_FOLD_KEY), Number.POSITIVE_INFINITY);
  });

  it("下一页放几条：工作区不超过 5 也不超过剩下的；TASKS 一次放完", () => {
    deepStrictEqual(nextPageSize("workspace:a", 23), 5);
    deepStrictEqual(nextPageSize("workspace:a", 3), 3);
    deepStrictEqual(nextPageSize(TASKS_FOLD_KEY, 23), 23);
  });

  it("各组互不影响", () => {
    const a = showMoreInGroup(empty(), "workspace:a");
    deepStrictEqual(groupVisibleLimit(a, "workspace:b"), 5);
  });

  it("不动折叠态——收起 Show more 不该顺带把组折了", () => {
    const folded = toggleGroupFold(empty(), TASKS_FOLD_KEY);
    const more = showMoreInGroup(folded, TASKS_FOLD_KEY);
    deepStrictEqual(isGroupFolded(more, TASKS_FOLD_KEY), true);
    deepStrictEqual(isGroupFolded(showLessInGroup(more, TASKS_FOLD_KEY), TASKS_FOLD_KEY), true);
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
