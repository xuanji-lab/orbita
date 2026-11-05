import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginPlacement, PluginScope, PluginView } from "../../../../shared/plugin.ts";
import type { Workspace } from "../../../../shared/workspace.ts";
import {
  contentsParts,
  filterPlugins,
  groupPlugins,
  initialOf,
  isActive,
  legacyCounts,
  sourceKey,
  toggleTarget,
  toggleWorkspaceInScope,
} from "./plugin-view.ts";

const ws = (id: string, name: string): Workspace => ({ id, name, path: `/${name}`, createdAt: 0, attachedDirs: [] });
const WORKSPACES = [ws("a", "意图系统"), ws("b", "orbita"), ws("c", "DDPM")];

function view(over: Partial<PluginView> & { id: string; name: string }): PluginView {
  return {
    origin: "plugin",
    description: "",
    author: null,
    version: null,
    license: null,
    scope: { kind: "global" },
    placement: { kind: "global" },
    contents: { skills: 1, mcp: 0, scripts: false },
    skills: [],
    mcp: [],
    unsupported: [],
    config: [],
    conflicts: [],
    problems: [],
    install: null,
    location: null,
    ...over,
  };
}

describe("groupPlugins", () => {
  test("所有工作区 → 各工作区（侧栏顺序）→ 未启用；空组不出现", () => {
    const groups = groupPlugins(
      [
        view({ id: "plugin:g", name: "G" }),
        view({ id: "plugin:w", name: "W", scope: { kind: "workspaces", ids: ["b"] }, placement: { kind: "workspaces", ids: ["b"] } }),
        view({ id: "skill:n", name: "N", origin: "user-skill", scope: { kind: "off" }, placement: null }),
      ],
      WORKSPACES,
    );
    assert.deepEqual(groups.map((g) => (g.kind === "workspace" ? `ws:${g.workspace.id}` : g.kind)), ["global", "ws:b", "none"]);
  });

  test("装在两个工作区的行在两组各出现一次", () => {
    const both = view({ id: "plugin:x", name: "X", scope: { kind: "workspaces", ids: ["a", "c"] }, placement: { kind: "workspaces", ids: ["a", "c"] } });
    const groups = groupPlugins([both], WORKSPACES);
    assert.deepEqual(groups.map((g) => (g.kind === "workspace" ? g.workspace.id : g.kind)), ["a", "c"]);
    assert.equal(groups.every((g) => g.items.length === 1), true);
  });

  test("停用的行仍落在记着的位置里（不跳去未启用）", () => {
    const off = view({ id: "mcp:s", name: "S", origin: "user-mcp", scope: { kind: "off" }, placement: { kind: "global" } });
    const groups = groupPlugins([off], WORKSPACES);
    assert.deepEqual(groups.map((g) => g.kind), ["global"]);
  });

  test("位置里的工作区全都已不在侧栏（被删了）：落未启用，不凭空消失", () => {
    const orphan = view({ id: "plugin:o", name: "O", scope: { kind: "workspaces", ids: ["gone"] }, placement: { kind: "workspaces", ids: ["gone"] } });
    assert.deepEqual(groupPlugins([orphan], WORKSPACES).map((g) => g.kind), ["none"]);
  });

  test("组内按显示名排，同名按 id；不改入参顺序", () => {
    const input = [view({ id: "plugin:b2", name: "同名" }), view({ id: "plugin:b1", name: "同名" }), view({ id: "plugin:a", name: "A" })];
    const snapshot = input.map((v) => v.id);
    const groups = groupPlugins(input, WORKSPACES);
    assert.deepEqual(groups[0]?.items.map((v) => v.id), ["plugin:a", "plugin:b1", "plugin:b2"]);
    assert.deepEqual(input.map((v) => v.id), snapshot);
  });

  test("没有插件：没有组", () => {
    assert.deepEqual(groupPlugins([], WORKSPACES), []);
  });
});

describe("filterPlugins", () => {
  const list = [
    view({ id: "plugin:pdf", name: "PDF", description: "排版报告", skills: [{ slug: "pdf", name: "pdf", description: "" }] }),
    view({ id: "mcp:miyo", name: "miyo", origin: "user-mcp", mcp: [{ name: "search", qualified: "miyo", transport: "stdio", commandLine: "", problem: null }] }),
  ];
  test("名字、描述、技能名、服务名任一命中，不分大小写；空词不筛", () => {
    assert.deepEqual(filterPlugins(list, "排版").map((v) => v.id), ["plugin:pdf"]);
    assert.deepEqual(filterPlugins(list, "MIYO").map((v) => v.id), ["mcp:miyo"]);
    assert.deepEqual(filterPlugins(list, "search").map((v) => v.id), ["mcp:miyo"]);
    assert.equal(filterPlugins(list, "  ").length, 2);
    assert.equal(filterPlugins(list, "zzz").length, 0);
  });
});

describe("isActive / toggleTarget", () => {
  test("global 与有名单的 workspaces 算生效；off 与空名单不算", () => {
    assert.equal(isActive(view({ id: "a", name: "a", scope: { kind: "global" } })), true);
    assert.equal(isActive(view({ id: "a", name: "a", scope: { kind: "workspaces", ids: ["x"] } })), true);
    assert.equal(isActive(view({ id: "a", name: "a", scope: { kind: "workspaces", ids: [] } })), false);
    assert.equal(isActive(view({ id: "a", name: "a", scope: { kind: "off" } })), false);
  });

  test("拨一下：生效 → 停用；停用 → 回记着的位置；没位置或空名单 → 所有工作区（拨开必须真生效）", () => {
    const on = view({ id: "a", name: "a", scope: { kind: "workspaces", ids: ["b"] }, placement: { kind: "workspaces", ids: ["b"] } });
    assert.deepEqual(toggleTarget(on), { kind: "off" });
    const placement: PluginPlacement = { kind: "workspaces", ids: ["b"] };
    assert.deepEqual(toggleTarget(view({ id: "a", name: "a", scope: { kind: "off" }, placement })), placement);
    assert.deepEqual(toggleTarget(view({ id: "a", name: "a", scope: { kind: "off" }, placement: null })), { kind: "global" });
    assert.deepEqual(toggleTarget(view({ id: "a", name: "a", scope: { kind: "off" }, placement: { kind: "workspaces", ids: [] } })), { kind: "global" });
  });
});

describe("contentsParts / sourceKey / legacyCounts / initialOf", () => {
  test("里面有什么：技能 N · MCP · 脚本，为 0 的段不出现", () => {
    assert.deepEqual(contentsParts({ skills: 2, mcp: 1, scripts: true }), [
      { kind: "skills", count: 2 },
      { kind: "mcp", count: 1 },
      { kind: "scripts", count: 1 },
    ]);
    assert.deepEqual(contentsParts({ skills: 0, mcp: 0, scripts: false }), []);
  });

  test("来源：旧的看出身，真插件看装法", () => {
    assert.equal(sourceKey(view({ id: "a", name: "a", origin: "user-skill" })), "userSkill");
    assert.equal(sourceKey(view({ id: "a", name: "a", origin: "user-mcp" })), "userMcp");
    const install = (kind: "copy" | "link" | "git") =>
      ({ source: kind === "copy" ? { kind, from: "/x" } : kind === "link" ? { kind, path: "/x" } : { kind, url: "u", commit: "c" }, root: "/r", dataDir: "/d", installedAt: 0, updatedAt: 0 }) as const;
    assert.equal(sourceKey(view({ id: "a", name: "a", install: install("link") })), "link");
    assert.equal(sourceKey(view({ id: "a", name: "a", install: install("git") })), "git");
    assert.equal(sourceKey(view({ id: "a", name: "a", install: install("copy") })), "copy");
  });

  test("页首提示的数", () => {
    const counts = legacyCounts([
      view({ id: "1", name: "1", origin: "user-skill" }),
      view({ id: "2", name: "2", origin: "user-skill" }),
      view({ id: "3", name: "3", origin: "user-mcp" }),
      view({ id: "4", name: "4" }),
    ]);
    assert.deepEqual(counts, { skills: 2, mcp: 1 });
  });

  test("头像首字：按码点（不劈开代理对），空名给 ?", () => {
    assert.equal(initialOf("pdf"), "P");
    assert.equal(initialOf("文献追踪"), "文");
    assert.equal(initialOf("𠮷野家"), "𠮷");
    assert.equal(initialOf("  "), "?");
  });
});

describe("toggleWorkspaceInScope", () => {
  test("勾第一个进入 workspaces；再勾加进名单；取消最后一个落 off", () => {
    let scope: PluginScope = { kind: "off" };
    scope = toggleWorkspaceInScope(scope, "a");
    assert.deepEqual(scope, { kind: "workspaces", ids: ["a"] });
    scope = toggleWorkspaceInScope(scope, "b");
    assert.deepEqual(scope, { kind: "workspaces", ids: ["a", "b"] });
    scope = toggleWorkspaceInScope(scope, "a");
    assert.deepEqual(scope, { kind: "workspaces", ids: ["b"] });
    scope = toggleWorkspaceInScope(scope, "b");
    assert.deepEqual(scope, { kind: "off" });
  });

  test("从 global 起：勾一个就变成只在它", () => {
    assert.deepEqual(toggleWorkspaceInScope({ kind: "global" }, "a"), { kind: "workspaces", ids: ["a"] });
  });
});
