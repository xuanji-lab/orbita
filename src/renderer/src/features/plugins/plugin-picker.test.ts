import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginScope, PluginView } from "../../../../shared/plugin.ts";
import { activateRow, buildPicker, clampPick, collapseRow, expandRow, indexOfPlugin, movePick, tokenOfView } from "./plugin-picker.ts";

function view(id: string, name: string, scope: PluginScope, patch: Partial<PluginView> = {}): PluginView {
  const origin = id.startsWith("skill:") ? "user-skill" : id.startsWith("mcp:") ? "user-mcp" : "plugin";
  return {
    id,
    origin,
    name,
    description: `${name} 的描述`,
    author: null,
    version: null,
    license: null,
    scope,
    placement: scope.kind === "off" ? null : scope,
    contents: { skills: 0, mcp: 0, scripts: false },
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
    ...patch,
  };
}

const lit = view("plugin:lit-tracker", "文献追踪", { kind: "workspaces", ids: ["orbita"] }, {
  skills: [
    { slug: "lit-intake", name: "lit-intake", description: "爬" },
    { slug: "lit-digest", name: "lit-digest", description: "写" },
  ],
});
const kit = view("plugin:skill-kit", "技能工具箱", { kind: "global" }, { skills: [{ slug: "find-skills", name: "find-skills", description: "找" }] });
const graph = view("plugin:atlas", "Orbita 关系图谱", { kind: "workspaces", ids: ["other"] }, { skills: [{ slug: "atlas-map", name: "atlas-map", description: "图" }] });
const loose = view("skill:academic-section-flow", "academic-section-flow", { kind: "workspaces", ids: ["orbita"] });
const mcp = view("mcp:miyo", "miyo", { kind: "global" });
const all = [graph, mcp, loose, kit, lit];

describe("tokenOfView —— token 随来源走", () => {
  it("真插件 /plugin:、零散技能 /skill:、零散 MCP /mcp:（老用法不变）", () => {
    assert.equal(tokenOfView(lit), "/plugin:lit-tracker ");
    assert.equal(tokenOfView(loose), "/skill:academic-section-flow ");
    assert.equal(tokenOfView(mcp), "/mcp:miyo ");
  });
});

describe("buildPicker —— 断链技能", () => {
  it("断链的旧技能（文件夹没了）不进选取态：点名也读不到，只留在列表里给清理用", () => {
    const ghost = view("skill:ghost", "ghost", { kind: "off" }, { problems: [{ kind: "skill-folder-missing", detail: "ghost" }] });
    const model = buildPicker([...all, ghost], "orbita", "", null);
    const names = model.groups.flatMap((group) => group.rows.map((row) => (row.kind === "plugin" ? row.view.name : row.skill.name)));
    assert.equal(names.includes("ghost"), false);
    assert.equal(names.includes("miyo"), true);
  });
});

describe("buildPicker —— 分组与排序", () => {
  it("这个工作区能用的在前（真插件、零散技能、零散 MCP），没启用的排下面", () => {
    const model = buildPicker(all, "orbita", "", null);
    assert.deepEqual(model.groups.map((group) => group.key), ["usable", "elsewhere"]);
    const names = (key: "usable" | "elsewhere") =>
      model.groups.find((group) => group.key === key)?.rows.map((row) => (row.kind === "plugin" ? row.view.name : row.skill.name));
    assert.deepEqual(names("usable"), ["技能工具箱", "文献追踪", "academic-section-flow", "miyo"]);
    assert.deepEqual(names("elsewhere"), ["Orbita 关系图谱"]);
  });
  it("Home 会话（没有工作区）：只有所有工作区范围的可用", () => {
    const model = buildPicker(all, null, "", null);
    const usable = model.groups.find((group) => group.key === "usable")?.rows.map((row) => row.kind === "plugin" && row.view.id);
    assert.deepEqual(usable, ["plugin:skill-kit", "mcp:miyo"]);
  });
  it("筛选沿用插件页（名字 / 描述 / 技能名）；没有行就没有组", () => {
    assert.deepEqual(buildPicker(all, "orbita", "lit-digest", null).flat.map((row) => row.kind === "plugin" && row.id), ["plugin:lit-tracker"]);
    assert.deepEqual(buildPicker(all, "orbita", "不存在的词", null).groups, []);
  });
  it("没启用的行 usable 为 false、不可展开", () => {
    const row = buildPicker(all, "orbita", "", null).flat.find((each) => each.kind === "plugin" && each.id === "plugin:atlas");
    assert.ok(row !== undefined && row.kind === "plugin");
    assert.equal(row.usable, false);
    assert.equal(row.expandable, false);
  });
});

describe("展开 → 列出插件里的技能", () => {
  it("展开的插件后面紧跟它的技能行；技能行的 token 是 /skill:<slug>", () => {
    const model = buildPicker(all, "orbita", "", "plugin:lit-tracker");
    const at = indexOfPlugin(model.flat, "plugin:lit-tracker");
    const next = model.flat.slice(at + 1, at + 3);
    assert.deepEqual(next.map((row) => row.kind === "skill" && row.token), ["/skill:lit-intake ", "/skill:lit-digest "]);
  });
  it("零散技能 / MCP（没有里层）与没技能的插件不可展开；展开没启用的插件无效", () => {
    const model = buildPicker(all, "orbita", "", "plugin:atlas");
    assert.equal(model.flat.some((row) => row.kind === "skill"), false);
    const row = (id: string) => model.flat.find((each) => each.kind === "plugin" && each.id === id);
    const plain = row("skill:academic-section-flow");
    assert.ok(plain !== undefined && plain.kind === "plugin");
    assert.equal(plain.expandable, false);
  });
  it("→ 展开、再按无效；← 收起（技能行上按 ← 收起它所在的插件）", () => {
    const closed = buildPicker(all, "orbita", "", null).flat;
    const open = buildPicker(all, "orbita", "", "plugin:lit-tracker").flat;
    const litClosed = closed[indexOfPlugin(closed, "plugin:lit-tracker")];
    const litOpen = open[indexOfPlugin(open, "plugin:lit-tracker")];
    assert.deepEqual(expandRow(litClosed), { kind: "expand", id: "plugin:lit-tracker" });
    assert.deepEqual(expandRow(litOpen), { kind: "none" });
    assert.deepEqual(collapseRow(litOpen), { kind: "collapse", id: "plugin:lit-tracker" });
    assert.deepEqual(collapseRow(litClosed), { kind: "none" });
    assert.deepEqual(collapseRow(open[indexOfPlugin(open, "plugin:lit-tracker") + 1]), { kind: "collapse", id: "plugin:lit-tracker" });
    const looseRow = closed.find((row) => row.kind === "plugin" && row.id === "skill:academic-section-flow");
    assert.deepEqual(expandRow(looseRow), { kind: "none" });
  });
});

describe("activateRow —— ↵ / 点击", () => {
  it("可用插件插整个插件；展开里的技能插 /skill:", () => {
    const open = buildPicker(all, "orbita", "", "plugin:lit-tracker").flat;
    assert.deepEqual(activateRow(open[indexOfPlugin(open, "plugin:lit-tracker")]), { kind: "insert", token: "/plugin:lit-tracker " });
    assert.deepEqual(activateRow(open[indexOfPlugin(open, "plugin:lit-tracker") + 1]), { kind: "insert", token: "/skill:lit-intake " });
  });
  it("没启用的：不插入，只给「先启用」的提示（带显示名）", () => {
    const flat = buildPicker(all, "orbita", "", null).flat;
    assert.deepEqual(activateRow(flat[indexOfPlugin(flat, "plugin:atlas")]), { kind: "blocked", name: "Orbita 关系图谱" });
  });
  it("没有行（空列表）什么也不做", () => {
    assert.deepEqual(activateRow(undefined), { kind: "none" });
  });
});

describe("movePick / clampPick", () => {
  it("到头绕回；没有行 = -1；还没高亮时 ↓ 落第一行、↑ 落最后一行", () => {
    assert.equal(movePick(2, 1, 3), 0);
    assert.equal(movePick(0, -1, 3), 2);
    assert.equal(movePick(-1, 1, 3), 0);
    assert.equal(movePick(-1, -1, 3), 2);
    assert.equal(movePick(0, 1, 0), -1);
  });
  it("行数变了高亮夹回范围，有行至少亮第一行", () => {
    assert.equal(clampPick(5, 3), 2);
    assert.equal(clampPick(-1, 3), 0);
    assert.equal(clampPick(0, 0), -1);
  });
});
