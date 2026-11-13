import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pluginChipName, pluginNameMap } from "./plugin-names.ts";

describe("pluginNameMap / pluginChipName", () => {
  const names = pluginNameMap([
    { id: "plugin:lit-tracker", origin: "plugin", name: "文献追踪" },
    { id: "skill:review", origin: "user-skill", name: "review" },
    { id: "mcp:miyo", origin: "user-mcp", name: "miyo" },
  ]);
  it("只收真插件：标识 → 显示名", () => {
    assert.deepEqual([...names], [["lit-tracker", "文献追踪"]]);
  });
  it("取得到用显示名；取不到（卸了 / 还没读到）显示标识", () => {
    assert.equal(pluginChipName(names, "lit-tracker"), "文献追踪");
    assert.equal(pluginChipName(names, "ghost"), "ghost");
    assert.equal(pluginChipName(new Map([["a", ""]]), "a"), "a");
  });
});
