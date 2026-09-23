import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sameWorkspaceIds } from "./workspace-ids.ts";
import type { Workspace } from "@shared/workspace";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "ws-1",
  name: "orbita",
  path: "/Users/x/Orbita/orbita",
  createdAt: 0,
  attachedDirs: [],
  ...over,
});

describe("sameWorkspaceIds", () => {
  test("完全相同：true", () => {
    const a = [ws({ id: "a" }), ws({ id: "b" })];
    const b = [ws({ id: "a" }), ws({ id: "b" })];
    assert.equal(sameWorkspaceIds(a, b), true);
  });

  test("顺序不同：仍算相同", () => {
    const a = [ws({ id: "a" }), ws({ id: "b" })];
    const b = [ws({ id: "b" }), ws({ id: "a" })];
    assert.equal(sameWorkspaceIds(a, b), true);
  });

  test("增了一个：false", () => {
    const a = [ws({ id: "a" })];
    const b = [ws({ id: "a" }), ws({ id: "b" })];
    assert.equal(sameWorkspaceIds(a, b), false);
  });

  test("删了一个：false", () => {
    const a = [ws({ id: "a" }), ws({ id: "b" })];
    const b = [ws({ id: "a" })];
    assert.equal(sameWorkspaceIds(a, b), false);
  });

  test("换了一个（id 不同但长度一样）：false", () => {
    const a = [ws({ id: "a" }), ws({ id: "b" })];
    const b = [ws({ id: "a" }), ws({ id: "c" })];
    assert.equal(sameWorkspaceIds(a, b), false);
  });

  test("改名 / 换路径 / 换 attachedDirs：id 集合没变，不算变化", () => {
    const a = [ws({ id: "a", name: "old-name", path: "/old/path" })];
    const b = [ws({ id: "a", name: "new-name", path: "/new/path", attachedDirs: ["/extra"] })];
    assert.equal(sameWorkspaceIds(a, b), true);
  });

  test("两份都空：true", () => {
    assert.equal(sameWorkspaceIds([], []), true);
  });
});
