import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Workspace } from "@shared/workspace";
import {
  FILTER_ALL,
  bucketCounts,
  buildOptions,
  defaultFilter,
  filterKey,
  groupByWorkspace,
  resolveFilter,
  workspaceBucket,
  type WsFilter,
} from "./workspace-filter.ts";

const ws = (id: string): Workspace => ({ id, name: id.toUpperCase(), path: `/p/${id}`, createdAt: 0, attachedDirs: [] });
const A = ws("a");
const B = ws("b");
const spaces = [A, B];
const ALLOW = { tasks: true, global: true };
const wsFilter = (id: string): WsFilter => ({ kind: "workspace", id });

describe("默认选中与悬空态", () => {
  test("当前会话在某工作区 → 选它；Home / 无工作区 / 工作区已移除 → 全部", () => {
    assert.deepEqual(defaultFilter("a", spaces), wsFilter("a"));
    assert.deepEqual(defaultFilter(null, spaces), FILTER_ALL);
    assert.deepEqual(defaultFilter("gone", spaces), FILTER_ALL);
  });

  test("选过的优先于默认；选中的工作区被移除退回全部；不提供的档退回全部", () => {
    assert.deepEqual(resolveFilter(wsFilter("b"), wsFilter("a"), spaces, ALLOW), wsFilter("b"));
    assert.deepEqual(resolveFilter(undefined, wsFilter("a"), spaces, ALLOW), wsFilter("a"));
    assert.deepEqual(resolveFilter(wsFilter("gone"), FILTER_ALL, spaces, ALLOW), FILTER_ALL);
    assert.deepEqual(resolveFilter({ kind: "global" }, FILTER_ALL, spaces, { tasks: true, global: false }), FILTER_ALL);
    assert.deepEqual(resolveFilter({ kind: "tasks" }, FILTER_ALL, spaces, { tasks: false, global: true }), FILTER_ALL);
    assert.deepEqual(resolveFilter({ kind: "tasks" }, FILTER_ALL, spaces, ALLOW), { kind: "tasks" });
  });

  test("filterKey 区分四档", () => {
    assert.deepEqual(
      [FILTER_ALL, { kind: "tasks" } as const, { kind: "global" } as const, wsFilter("a")].map(filterKey),
      ["all", "tasks", "global", "ws:a"],
    );
  });
});

describe("分桶", () => {
  const items = [
    { id: 1, w: "a" },
    { id: 2, w: "b" },
    { id: 3, w: null },
    { id: 4, w: "gone" },
    { id: 5, w: "a" },
  ];
  const of = (item: { w: string | null }): string | null => item.w;

  test("无工作区与归属指向已移除工作区的都归「任务」", () => {
    assert.equal(workspaceBucket("gone", spaces), null);
    assert.equal(workspaceBucket(null, spaces), null);
    assert.equal(workspaceBucket("a", spaces), "a");
    const counts = bucketCounts(items, of, spaces);
    assert.equal(counts.tasks, 2);
    assert.equal(counts.perWorkspace.get("a"), 2);
    assert.equal(counts.perWorkspace.get("b"), 1);
  });

  test("「全部」：各工作区（侧栏顺序）再接任务，组内保持入参顺序；空组不出", () => {
    const groups = groupByWorkspace(items, of, [B, A], FILTER_ALL);
    assert.deepEqual(groups.map((g) => g.workspace?.id ?? null), ["b", "a", null]);
    assert.deepEqual(groups[1]?.items.map((i) => i.id), [1, 5]);
    assert.deepEqual(groupByWorkspace([items[0]!], of, spaces, FILTER_ALL).map((g) => g.workspace?.id), ["a"]);
  });

  test("选某个工作区 / 任务只剩那一组；那一组没东西就是空数组；全局档返回空", () => {
    assert.deepEqual(groupByWorkspace(items, of, spaces, wsFilter("b")).map((g) => g.workspace?.id), ["b"]);
    assert.deepEqual(groupByWorkspace(items, of, spaces, { kind: "tasks" }).map((g) => g.workspace), [null]);
    assert.deepEqual(groupByWorkspace([items[0]!], of, spaces, wsFilter("b")), []);
    assert.deepEqual(groupByWorkspace(items, of, spaces, { kind: "global" }), []);
  });
});

describe("选项", () => {
  const base = { workspaces: spaces, total: 10, perWorkspace: new Map([["a", 7]]), tasks: 3, global: null, selected: FILTER_ALL, hideEmpty: true };

  test("hideEmpty：零条的工作区不出，任务有则出", () => {
    const options = buildOptions(base);
    assert.deepEqual(options.map((o) => filterKey(o.filter)), ["all", "ws:a", "tasks"]);
    assert.deepEqual(options.map((o) => o.count), [10, 7, 3]);
  });

  test("选中的那档即使为零也恒在", () => {
    const options = buildOptions({ ...base, selected: wsFilter("b") });
    assert.deepEqual(options.map((o) => filterKey(o.filter)), ["all", "ws:a", "ws:b", "tasks"]);
  });

  test("present：条数为零但列着东西（只剩办结事项）的工作区不能藏", () => {
    const options = buildOptions({ ...base, perWorkspace: new Map([["a", 7], ["b", 0]]), present: { perWorkspace: new Map([["b", 2]]), tasks: 0 } });
    assert.deepEqual(options.map((o) => filterKey(o.filter)), ["all", "ws:a", "ws:b", "tasks"]);
    assert.equal(options[2]?.count, 0);
  });

  test("不 hideEmpty（能力面板）：每个工作区都在；global 为数字时末尾多一档；tasks 为 null 无任务档", () => {
    const options = buildOptions({ ...base, hideEmpty: false, tasks: null, global: 4 });
    assert.deepEqual(options.map((o) => filterKey(o.filter)), ["all", "ws:a", "ws:b", "global"]);
    assert.equal(options[3]?.count, 4);
  });
});
