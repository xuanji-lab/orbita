import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginPreview } from "../../shared/plugin.ts";
import { EMPTY_PLUGIN_IO } from "../../shared/plugin-board.ts";
import { draftViewOf, emptyDraftView } from "./draft-view.ts";

const preview: PluginPreview = {
  previewId: null,
  name: "lit",
  displayName: "文献追踪",
  version: "0.1.0",
  description: "d",
  author: null,
  license: null,
  source: { kind: "folder", path: "/p" },
  mode: "link",
  manifestFile: ".claude-plugin/plugin.json",
  root: "/p",
  hasScripts: true,
  skills: [{ slug: "scan", name: "scan", description: "x" }],
  workflow: [],
  io: EMPTY_PLUGIN_IO,
  external: [],
  board: { title: "t", spec: null, cards: [{ id: "a", title: "a", size: "1x1", note: null, template: "./a.html", data: null, sample: null, repeat: null }] },
  tuned: true,
  mcp: [],
  unsupported: [],
  config: [],
  conflicts: [{ kind: "plugin-exists", name: "lit" }],
  problems: [],
};

describe("draftViewOf", () => {
  test("草稿视图：没有范围、没有安装记录、不报冲突；清单里的各节原样带上", () => {
    const view = draftViewOf(preview);
    assert.equal(view.id, "plugin:lit");
    assert.equal(view.name, "文献追踪");
    assert.deepEqual(view.scope, { kind: "off" });
    assert.equal(view.install, null);
    assert.deepEqual(view.conflicts, []);
    assert.deepEqual(view.contents, { skills: 1, mcp: 0, scripts: true });
    assert.equal(view.board?.cards.length, 1);
    assert.equal(view.tuned, true);
  });

  test("空文件夹：一张什么都没有的页（所有节为空）", () => {
    const view = emptyDraftView("early", "/p/early");
    assert.equal(view.name, "early");
    assert.equal(view.board, null);
    assert.deepEqual(view.io, EMPTY_PLUGIN_IO);
    assert.deepEqual(view.skills, []);
  });
});
