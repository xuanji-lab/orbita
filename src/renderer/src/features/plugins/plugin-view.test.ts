import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginPlacement, PluginScope, PluginView } from "../../../../shared/plugin.ts";
import type { Workspace } from "../../../../shared/workspace.ts";
import {
  canRemoveMcpView,
  contentsParts,
  filterEnabled,
  filterPlugins,
  groupPlugins,
  installedNamesOf,
  creatorAvailable,
  archivedScopeText,
  availabilityScopeOf,
  isActive,
  isBuiltinView,
  isMissingSkillView,
  nextAvailability,
  rowKind,
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
    workflow: [],
    io: { reads: [], writes: [] },
    external: [],
    board: null,
    tuned: false,
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

describe("filterEnabled（仅显示已启用）", () => {
  const on = view({ id: "plugin:on", name: "On" });
  const scoped = view({ id: "plugin:ws", name: "Ws", scope: { kind: "workspaces", ids: ["a"] }, placement: { kind: "workspaces", ids: ["a"] } });
  // 停用的仍记着位置，分组里照常在它的工作区（开关一拨就回原位）；过滤只看此刻生效不生效
  const off = view({ id: "plugin:off", name: "Off", scope: { kind: "off" } });
  const emptyList = view({ id: "plugin:empty", name: "Empty", scope: { kind: "workspaces", ids: [] } });

  test("开着只留此刻生效的：全局、有名单的工作区范围都算，停用与空名单不算", () => {
    assert.deepEqual(filterEnabled([on, scoped, off, emptyList], true).map((v) => v.id), ["plugin:on", "plugin:ws"]);
  });

  test("关着原样全留，并且是新数组（调用方排序不会动入参）", () => {
    const all = [on, off];
    const result = filterEnabled(all, false);
    assert.deepEqual(result.map((v) => v.id), ["plugin:on", "plugin:off"]);
    assert.notEqual(result, all);
  });

  test("先搜再过滤：两个条件叠加，过滤后一个不剩时分组为空（页面据此显示「还没有启用的插件」）", () => {
    const only = filterEnabled(filterPlugins([on, off], "off"), true);
    assert.deepEqual(only, []);
    assert.deepEqual(groupPlugins(only, WORKSPACES), []);
    assert.deepEqual(groupPlugins(filterEnabled([off], true), WORKSPACES), []);
  });

  test("停用的卡仍在自己的工作区组里（关着过滤时），开了过滤整组消失", () => {
    const placed = view({ id: "plugin:p", name: "P", scope: { kind: "off" }, placement: { kind: "workspaces", ids: ["b"] } });
    assert.deepEqual(groupPlugins(filterEnabled([placed], false), WORKSPACES).map((g) => g.kind), ["workspace"]);
    assert.deepEqual(groupPlugins(filterEnabled([placed], true), WORKSPACES), []);
  });
});

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

describe("contentsParts / sourceKey / legacyCounts", () => {
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
    const builtin = view({ id: "plugin:plugin-creator", name: "p", install: { source: { kind: "builtin" }, root: "/r", dataDir: "/d", installedAt: 0, updatedAt: 0 } });
    assert.equal(sourceKey(builtin), "builtin");
    assert.equal(isBuiltinView(builtin), true);
    assert.equal(isBuiltinView(view({ id: "a", name: "a", install: install("link") })), false);
  });

  test("「和智能体一起做一个」：plugin-creator 被停用才点不得；没列到（加载中 / 没带资源）不拦", () => {
    const creator = (scope: PluginView["scope"]) => view({ id: "plugin:plugin-creator", name: "plugin-creator", scope });
    assert.equal(creatorAvailable([creator({ kind: "global" })]), true);
    assert.equal(creatorAvailable([creator({ kind: "workspaces", ids: ["a"] })]), true);
    assert.equal(creatorAvailable([creator({ kind: "off" })]), false);
    assert.equal(creatorAvailable([view({ id: "plugin:other", name: "other" })]), true);
    assert.equal(creatorAvailable([]), true);
  });

  test("旧 MCP 的「移除」按钮：只对 user-mcp 出；插件页里它们都来自全局 mcp.json，remove 都够得着", () => {
    assert.equal(canRemoveMcpView(view({ id: "mcp:kimi-cu", name: "kimi-cu", origin: "user-mcp", scope: { kind: "off" } })), true);
    assert.equal(canRemoveMcpView(view({ id: "plugin:x", name: "x" })), false);
    assert.equal(canRemoveMcpView(view({ id: "skill:pdf", name: "pdf", origin: "user-skill" })), false);
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

describe("installedNamesOf：对话里那一行靠它判断「已装上」", () => {
  test("真插件（有安装记录）算；旧技能 / 旧 MCP / 没有安装记录的不算", () => {
    const install = { source: { kind: "link" as const, path: "/p" }, root: "/p", dataDir: "/d", installedAt: 0, updatedAt: 0 };
    const names = installedNamesOf([
      view({ id: "plugin:lit", name: "lit", install }),
      view({ id: "plugin:plugin-creator", name: "creator", install: { ...install, source: { kind: "builtin" } } }),
      view({ id: "skill:pdf", name: "pdf", origin: "user-skill" }),
      view({ id: "mcp:fs", name: "fs", origin: "user-mcp" }),
      view({ id: "plugin:ghost", name: "ghost", install: null }),
    ]);
    assert.deepEqual([...names].sort(), ["lit", "plugin-creator"]);
  });
});

describe("rowKind：列表行右侧的种类小标", () => {
  const install = (kind: "builtin" | "copy" | "link") =>
    ({ source: kind === "builtin" ? { kind } : kind === "copy" ? { kind, from: "/x" } : { kind, path: "/x" } }) as PluginView["install"];
  test("插件 / 内置 / 技能 / MCP 四种", () => {
    assert.equal(rowKind(view({ id: "plugin:a", name: "a", install: install("copy") })), "plugin");
    assert.equal(rowKind(view({ id: "plugin:a", name: "a", install: install("link") })), "plugin");
    assert.equal(rowKind(view({ id: "plugin:b", name: "b", install: install("builtin") })), "builtin");
    assert.equal(rowKind(view({ id: "skill:s", name: "s", origin: "user-skill" })), "skill");
    assert.equal(rowKind(view({ id: "mcp:m", name: "m", origin: "user-mcp" })), "mcp");
  });
});

describe("isMissingSkillView", () => {
  test("只认旧技能身上的断链问题；插件里的同名问题与别的问题都不算", () => {
    const problem = { kind: "skill-folder-missing" as const, detail: "x" };
    assert.equal(isMissingSkillView(view({ id: "skill:x", name: "x", origin: "user-skill", problems: [problem] })), true);
    assert.equal(isMissingSkillView(view({ id: "skill:x", name: "x", origin: "user-skill", problems: [{ kind: "path-missing", detail: "x" }] })), false);
    assert.equal(isMissingSkillView(view({ id: "plugin:x", name: "x", problems: [problem] })), false);
  });
});

describe("在哪儿可用：小标点击 → 新范围", () => {
  const A = { kind: "workspace" as const, id: "a" };
  const B = { kind: "workspace" as const, id: "b" };
  const G = { kind: "global" as const };

  test("技能：全局 ↔ 停用；全局时点工作区 = 只在这一个；名单里加入 / 取消，点空 = 停用", () => {
    assert.deepEqual(nextAvailability({ kind: "off" }, G, false), { kind: "global" });
    assert.deepEqual(nextAvailability({ kind: "global" }, G, false), { kind: "off" });
    assert.deepEqual(nextAvailability({ kind: "global" }, A, false), { kind: "workspaces", ids: ["a"] });
    assert.deepEqual(nextAvailability({ kind: "workspaces", ids: ["a"] }, B, false), { kind: "workspaces", ids: ["a", "b"] });
    assert.deepEqual(nextAvailability({ kind: "workspaces", ids: ["a", "b"] }, A, false), { kind: "workspaces", ids: ["b"] });
    assert.deepEqual(nextAvailability({ kind: "workspaces", ids: ["a"] }, A, false), { kind: "off" });
    assert.deepEqual(nextAvailability({ kind: "workspaces", ids: ["a"] }, G, false), { kind: "global" });
  });

  test("MCP（keepOne）：不许点空——空名单会被当成停用，那是「启用」开关的事；其余照常", () => {
    assert.equal(nextAvailability({ kind: "global" }, G, true), null);
    assert.equal(nextAvailability({ kind: "workspaces", ids: ["a"] }, A, true), null);
    assert.deepEqual(nextAvailability({ kind: "workspaces", ids: ["a", "b"] }, A, true), { kind: "workspaces", ids: ["b"] });
    assert.deepEqual(nextAvailability({ kind: "global" }, A, true), { kind: "workspaces", ids: ["a"] });
  });

  test("显示的范围：MCP 停用时照记着的位置画（小标不因停用而全灭）；技能照有效范围", () => {
    const mcp = view({ id: "mcp:m", name: "m", origin: "user-mcp", scope: { kind: "off" }, placement: { kind: "workspaces", ids: ["a"] } });
    assert.deepEqual(availabilityScopeOf(mcp), { kind: "workspaces", ids: ["a"] });
    assert.deepEqual(availabilityScopeOf({ ...mcp, placement: null }), { kind: "off" });
    const skill = view({ id: "skill:s", name: "s", origin: "user-skill", scope: { kind: "global" } });
    assert.deepEqual(availabilityScopeOf(skill), { kind: "global" });
  });
});

describe("archivedScopeText：已归档行上的范围", () => {
  const nameOf = (id: string): string | null => ({ a: "paper-a", b: "paper-b" })[id] ?? null;
  test("全局优先；工作区列名字；已不存在的工作区不列；都没有为空串", () => {
    assert.equal(archivedScopeText({ global: true, workspaces: ["a"] }, "全局", nameOf), "全局");
    assert.equal(archivedScopeText({ global: false, workspaces: ["a", "gone", "b"] }, "全局", nameOf), "paper-a、paper-b");
    assert.equal(archivedScopeText({ global: false, workspaces: ["gone"] }, "全局", nameOf), "");
    assert.equal(archivedScopeText({ global: false, workspaces: [] }, "全局", nameOf), "");
  });
});
