import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Carryover, SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { carryoverCounts, groupCarryovers, groupCarryoversByWorkspace } from "./carryover-groups.ts";
import { FILTER_ALL } from "./workspace-filter.ts";

const ws = (id: string): Workspace => ({ id, name: id, path: `/p/${id}`, createdAt: 0, attachedDirs: [] });
const meta = (id: string, workspaceId: string | null): SessionMeta => ({ id, workspaceId }) as SessionMeta;
const item = (id: string, source: string, status: Carryover["status"] = "open"): Carryover =>
  ({ id, sourceSessionId: source, status }) as Carryover;

const spaces = [ws("a"), ws("b")];
// 会话列表顺序 = 最近的在前
const sessions = [meta("s1", "a"), meta("s2", "b"), meta("s3", null), meta("s4", "a")];
const items = [item("i1", "s4"), item("i2", "s1"), item("i3", "s2"), item("i4", "s3"), item("i5", "gone"), item("i6", "s1", "dismissed"), item("i7", "s1", "done")];

describe("以后再做：工作区 → 来源会话 → 事项", () => {
  test("丢掉的不列；来源已删的堆在最后", () => {
    const flat = groupCarryovers(items, sessions);
    assert.deepEqual(flat.map((g) => g.session?.id ?? null), ["s1", "s2", "s3", "s4", null]);
    assert.deepEqual(flat[0]?.items.map((i) => i.id), ["i2", "i7"]);
  });

  test("「全部」：按侧栏顺序先 a 后 b，工作区内保持会话顺序；没有工作区与来源已删的进任务组末尾", () => {
    const groups = groupCarryoversByWorkspace(items, sessions, spaces, FILTER_ALL);
    assert.deepEqual(groups.map((g) => g.workspace?.id ?? null), ["a", "b", null]);
    assert.deepEqual(groups[0]?.groups.map((g) => g.session?.id), ["s1", "s4"]);
    assert.equal(groups[0]?.count, 2); // i7 已办结：列着但不计
    assert.deepEqual(groups[2]?.groups.map((g) => g.session?.id ?? null), ["s3", null]);
    assert.equal(groups[2]?.count, 2);
  });

  test("选某个工作区只剩那一组；选任务只剩任务组", () => {
    assert.deepEqual(groupCarryoversByWorkspace(items, sessions, spaces, { kind: "workspace", id: "b" }).map((g) => g.workspace?.id), ["b"]);
    assert.deepEqual(groupCarryoversByWorkspace(items, sessions, spaces, { kind: "tasks" }).map((g) => g.workspace), [null]);
  });

  test("选择条上的条数 = 没办完的（办结与丢掉的都不计）；列着的另算", () => {
    const counts = carryoverCounts(items, sessions, spaces);
    assert.equal(counts.total, 5);
    assert.equal(counts.perWorkspace.get("a"), 2);
    assert.equal(counts.perWorkspace.get("b"), 1);
    assert.equal(counts.tasks, 2);
    assert.equal(counts.listed.total, 6);
    assert.equal(counts.listed.perWorkspace.get("a"), 3);
  });
});
