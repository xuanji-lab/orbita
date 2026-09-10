import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { TASKS_FOLD_KEY, foldKeyForWorkspace, toggleFold, unfold } from "./sidebar-fold.ts";

describe("toggleFold", () => {
  it("折起的组再翻一次就展开（正常路径）", () => {
    const folded = toggleFold(new Set<string>(), TASKS_FOLD_KEY);
    deepStrictEqual(folded.has(TASKS_FOLD_KEY), true);
    const reopened = toggleFold(folded, TASKS_FOLD_KEY);
    deepStrictEqual(reopened.has(TASKS_FOLD_KEY), false);
  });

  it("不改动原集合——React 靠新引用才知道要重渲染", () => {
    const original = new Set<string>(["workspace:a"]);
    const next = toggleFold(original, "workspace:b");
    deepStrictEqual(original.has("workspace:b"), false);
    deepStrictEqual(next.has("workspace:b"), true);
  });
});

describe("unfold", () => {
  it("折着的组被展开", () => {
    const folded = toggleFold(new Set<string>(), "workspace:a");
    deepStrictEqual(unfold(folded, "workspace:a").has("workspace:a"), false);
  });

  it("没折过的组原样返回同一引用，不白付一次重渲染", () => {
    const original = new Set<string>(["workspace:a"]);
    deepStrictEqual(unfold(original, "workspace:b"), original);
  });
});

describe("foldKeyForWorkspace", () => {
  it("带命名空间——不同工作区不串key，也不与 TASKS 的固定 key 撞车", () => {
    deepStrictEqual(foldKeyForWorkspace("a"), "workspace:a");
    deepStrictEqual(foldKeyForWorkspace(TASKS_FOLD_KEY), "workspace:tasks");
    deepStrictEqual(foldKeyForWorkspace("a") === TASKS_FOLD_KEY, false);
  });
});
