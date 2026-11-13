import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginScope, PluginView } from "../../shared/plugin.ts";
import { emptyDraftView } from "./draft-view.ts";
import { invokedPluginOf } from "./invoked.ts";

function view(scope: PluginScope, patch: Partial<PluginView> = {}): PluginView {
  return {
    ...emptyDraftView("lit-tracker", "/p/lit-tracker"),
    name: "文献追踪",
    scope,
    skills: [
      { slug: "lit-digest", name: "lit-digest", description: "d" },
      { slug: "lit-intake", name: "lit-intake", description: "d" },
    ],
    workflow: [
      { title: "爬论文", skill: "lit-intake", skillSlug: "lit-intake", detail: null, output: null, wait: null },
      { title: "写周报", skill: "lit-digest", skillSlug: "lit-digest", detail: null, output: null, wait: null },
    ],
    ...patch,
  };
}

const locate = (slug: string): string | null => `/p/lit-tracker/skills/${slug}/SKILL.md`;

describe("invokedPluginOf", () => {
  test("没装（视图缺席）→ not-installed", () => {
    assert.deepEqual(invokedPluginOf("ghost", undefined, "ws", locate), { target: "ghost", state: "not-installed" });
  });
  test("旧技能 / 旧 MCP 那种非真插件，或名字对不上 → 当没装", () => {
    assert.equal(invokedPluginOf("lit-tracker", view({ kind: "global" }, { origin: "user-skill", id: "skill:lit-tracker" }), "ws", locate).state, "not-installed");
    assert.equal(invokedPluginOf("other", view({ kind: "global" }), "ws", locate).state, "not-installed");
  });
  test("装了但对这个工作区没启用（停用 / 只在别的工作区 / Home 会话没有所有工作区）→ disabled，带显示名", () => {
    const cases: Array<[PluginScope, string | null]> = [
      [{ kind: "off" }, "ws"],
      [{ kind: "workspaces", ids: ["other"] }, "ws"],
      [{ kind: "workspaces", ids: ["ws"] }, null],
    ];
    for (const [scope, ws] of cases) {
      assert.deepEqual(invokedPluginOf("lit-tracker", view(scope), ws, locate), { target: "lit-tracker", state: "disabled", displayName: "文献追踪" });
    }
  });
  test("启用：入口 = 工作流第一步点名的技能（不是技能列表第一条），工作流与看板如实带上", () => {
    const board = { title: "看板", spec: null, cards: [] };
    const out = invokedPluginOf("lit-tracker", view({ kind: "workspaces", ids: ["ws"] }, { board }), "ws", locate);
    assert.deepEqual(out, {
      target: "lit-tracker",
      state: "enabled",
      displayName: "文献追踪",
      workflow: [
        { title: "爬论文", skill: "lit-intake" },
        { title: "写周报", skill: "lit-digest" },
      ],
      entry: { skill: "lit-intake", location: "/p/lit-tracker/skills/lit-intake/SKILL.md" },
      hasBoard: true,
    });
  });
  test("没有工作流取第一条技能；没有看板 hasBoard 为 false", () => {
    const out = invokedPluginOf("lit-tracker", view({ kind: "global" }, { workflow: [] }), "ws", locate);
    assert.equal(out.state === "enabled" && out.entry?.skill, "lit-digest");
    assert.equal(out.state === "enabled" && out.hasBoard, false);
  });
  test("入口技能文件找不到（装配里没有它）或插件没有技能 → entry 为 null，不编路径", () => {
    const missing = invokedPluginOf("lit-tracker", view({ kind: "global" }), "ws", () => null);
    assert.equal(missing.state === "enabled" && missing.entry, null);
    const none = invokedPluginOf("lit-tracker", view({ kind: "global" }, { skills: [], workflow: [] }), "ws", locate);
    assert.equal(none.state === "enabled" && none.entry, null);
  });
});
