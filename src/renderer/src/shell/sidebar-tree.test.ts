/**
 * 侧栏挂父下两层树（B-2）的分组规则——纯函数穷尽测。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitByParent } from "./sidebar-tree.ts";
import type { SessionMeta } from "@shared/session";

const meta = (id: string, parentSessionId: string | null = null): SessionMeta => ({
  id,
  title: id,
  titleSource: "derived",
  cwd: "/repo",
  workspaceId: null,
  providerId: "p",
  modelId: "m",
  mode: "manual",
  parentSessionId,
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: 1,
});

describe("splitByParent（B-2）", () => {
  test("子挂在父行下，保持列表原有排序", () => {
    const tree = splitByParent([meta("a"), meta("a-1", "a"), meta("b"), meta("a-2", "a")]);
    assert.deepEqual(tree.top.map((m) => m.id), ["a", "b"]);
    assert.deepEqual(tree.childrenOf("a").map((m) => m.id), ["a-1", "a-2"]);
    assert.deepEqual(tree.childrenOf("b"), []);
  });

  test("父不在列表里（被删/被归档/被挪组）：子升为顶层，不跟着消失", () => {
    const tree = splitByParent([meta("orphan", "ghost"), meta("b")]);
    assert.deepEqual(tree.top.map((m) => m.id), ["orphan", "b"]);
    assert.deepEqual(tree.childrenOf("ghost"), []);
  });

  test("顶层会话与孙引用（深度只有一层）都归顶层——子不该再有子", () => {
    const tree = splitByParent([meta("a"), meta("a-1", "a"), meta("a-1-1", "a-1")]);
    assert.deepEqual(tree.top.map((m) => m.id), ["a", "a-1-1"]);
    assert.deepEqual(tree.childrenOf("a-1").map((m) => m.id), []);
  });

  test("空列表给空树；childrenOf 对未知 id 给空数组", () => {
    const tree = splitByParent([]);
    assert.deepEqual(tree.top, []);
    assert.deepEqual(tree.childrenOf("anything"), []);
  });
});
