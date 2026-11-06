import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginDraftEntry } from "../../../../shared/plugin.ts";
import type { Workspace } from "../../../../shared/workspace.ts";
import { draftOf, dropDraft, filterDrafts, groupDrafts, putDraft, shouldOpenDraft, type PluginDrafts } from "./plugin-draft.ts";

describe("草稿按会话记", () => {
  test("各记各的；同一个值再放回同一个引用（不触发多余渲染）；离开只清当前会话的", () => {
    const empty: PluginDrafts = new Map();
    const a = putDraft(empty, "s1", "plugins/lit");
    const b = putDraft(a, "s2", "plugins/other");
    assert.equal(draftOf(b, "s1"), "plugins/lit");
    assert.equal(draftOf(b, "s2"), "plugins/other");
    assert.equal(putDraft(b, "s1", "plugins/lit"), b);
    const c = dropDraft(b, "s1");
    assert.equal(draftOf(c, "s1"), null);
    assert.equal(draftOf(c, "s2"), "plugins/other");
    assert.equal(dropDraft(c, "nope"), c);
    assert.equal(draftOf(b, null), null, "首页没有草稿");
  });

  test("agent 对同一会话换了一个文件夹预览：换成新的", () => {
    const next = putDraft(putDraft(new Map(), "s1", "plugins/a"), "s1", "plugins/b");
    assert.equal(draftOf(next, "s1"), "plugins/b");
  });
});

describe("shouldOpenDraft：只在正看着该会话时打开右栏", () => {
  test("三种情形", () => {
    const base = { eventSessionId: "s1", viewedSessionId: "s1" };
    assert.equal(shouldOpenDraft(base), true);
    assert.equal(shouldOpenDraft({ ...base, viewedSessionId: "s2" }), false, "别的会话：只记下，不抢右栏");
    assert.equal(shouldOpenDraft({ ...base, viewedSessionId: null }), false, "首页");
  });
});

const ws = (id: string, name: string): Workspace => ({ id, name, path: `/${name}`, createdAt: 0, attachedDirs: [] });
const WORKSPACES = [ws("a", "意图系统"), ws("b", "orbita"), ws("c", "DDPM")];
const entry = (over: Partial<PluginDraftEntry> & { name: string }): PluginDraftEntry => ({
  workspaceId: "a",
  path: `/ws/plugins/${over.name}`,
  displayName: over.name,
  description: "",
  updatedAt: 0,
  sessionId: null,
  sessionTitle: null,
  manifestProblem: null,
  ...over,
});

describe("「正在做」组：按工作区分组", () => {
  test("当前工作区在前，其余按侧栏顺序；组内最近改动的在前；空组不出现", () => {
    const entries = [
      entry({ name: "x", workspaceId: "c", updatedAt: 1 }),
      entry({ name: "old", workspaceId: "b", updatedAt: 5 }),
      entry({ name: "new", workspaceId: "b", updatedAt: 9 }),
      entry({ name: "y", workspaceId: "a", updatedAt: 3 }),
    ];
    const groups = groupDrafts(entries, WORKSPACES, "b");
    assert.deepEqual(groups.map((group) => group.workspace.id), ["b", "a", "c"]);
    assert.deepEqual(groups[0]?.items.map((item) => item.name), ["new", "old"]);
    assert.deepEqual(groupDrafts(entries.slice(3), WORKSPACES, "c").map((group) => group.workspace.id), ["a"]);
  });

  test("没有当前工作区（Home）时就是侧栏顺序；工作区列表里已没有的工作区的草稿不显示（没有地方放）", () => {
    const entries = [entry({ name: "g", workspaceId: "gone" }), entry({ name: "z", workspaceId: "c" }), entry({ name: "y", workspaceId: "a" })];
    assert.deepEqual(groupDrafts(entries, WORKSPACES, null).map((group) => group.workspace.id), ["a", "c"]);
  });

  test("不改入参", () => {
    const entries = [entry({ name: "a", updatedAt: 1 }), entry({ name: "b", updatedAt: 2 })];
    const snapshot = entries.map((item) => item.name);
    groupDrafts(entries, WORKSPACES, null);
    assert.deepEqual(entries.map((item) => item.name), snapshot);
  });
});

describe("「正在做」组：筛选", () => {
  test("显示名 / 名字 / 描述任一包含查询词（不分大小写）；空词不筛", () => {
    const entries = [entry({ name: "recsys-scan", displayName: "推荐算法领域进度", description: "文献综述" }), entry({ name: "Lit", description: "追踪" })];
    assert.equal(filterDrafts(entries, "").length, 2);
    assert.deepEqual(filterDrafts(entries, "推荐").map((item) => item.name), ["recsys-scan"]);
    assert.deepEqual(filterDrafts(entries, "LIT").map((item) => item.name), ["Lit"]);
    assert.deepEqual(filterDrafts(entries, "综述").map((item) => item.name), ["recsys-scan"]);
    assert.deepEqual(filterDrafts(entries, "没有"), []);
  });
});
