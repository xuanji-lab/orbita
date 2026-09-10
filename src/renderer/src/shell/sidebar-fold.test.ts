import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TASKS_FOLD_KEY,
  foldKeyForWorkspace,
  toggleGroupFold,
  toggleGroupFull,
  unfoldGroup,
  type SidebarGroupState,
} from "./sidebar-fold.ts";

const empty = (): SidebarGroupState => ({ folds: new Set<string>(), full: new Set<string>() });

describe("toggleGroupFold", () => {
  it("折起的组再翻一次就展开（正常路径）", () => {
    const folded = toggleGroupFold(empty(), TASKS_FOLD_KEY);
    deepStrictEqual(folded.folds.has(TASKS_FOLD_KEY), true);
    const reopened = toggleGroupFold(folded, TASKS_FOLD_KEY);
    deepStrictEqual(reopened.folds.has(TASKS_FOLD_KEY), false);
  });

  it("折叠时清掉「全部显示」——重开回到默认预览，折叠才算归位", () => {
    const expanded = toggleGroupFull(empty(), "workspace:a");
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
    const next = toggleGroupFold(original, "workspace:a");
    deepStrictEqual(original.folds.has("workspace:a"), false);
    deepStrictEqual(next.folds.has("workspace:a"), true);
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
    const folded = toggleGroupFold(empty(), "workspace:a");
    const full = toggleGroupFull(folded, "workspace:a");
    deepStrictEqual(full.folds.has("workspace:a"), true);
  });
});

describe("unfoldGroup", () => {
  it("只展开折叠；没折过的组原样返回同一引用", () => {
    const folded = toggleGroupFold(empty(), "workspace:a");
    deepStrictEqual(unfoldGroup(folded, "workspace:a").folds.has("workspace:a"), false);
    const original = empty();
    deepStrictEqual(unfoldGroup(original, "workspace:b"), original);
  });
});

describe("foldKeyForWorkspace", () => {
  it("带命名空间——不同工作区不串key，也不与 TASKS 的固定 key 撞车", () => {
    deepStrictEqual(foldKeyForWorkspace("a"), "workspace:a");
    deepStrictEqual(foldKeyForWorkspace(TASKS_FOLD_KEY), "workspace:tasks");
    deepStrictEqual(foldKeyForWorkspace("a") === TASKS_FOLD_KEY, false);
  });
});
