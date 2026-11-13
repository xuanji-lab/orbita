import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginServerRows, type McpStatusSnapshot } from "./mcp.ts";

const row = (name: string): McpStatusSnapshot[number] => ({ name, status: { kind: "ready", tools: ["a"] }, instances: [] });

test("pluginServerRows：只留 plugin_ 前缀的行，原样带出（含状态与实例）", () => {
  const snapshot: McpStatusSnapshot = [row("everything"), row("plugin_lit_search"), row("plugin_x_y"), row("my_plugin_like")];
  assert.deepEqual(pluginServerRows(snapshot).map((each) => each.name), ["plugin_lit_search", "plugin_x_y"]);
  assert.equal(pluginServerRows(snapshot)[0], snapshot[1]);
});

test("pluginServerRows：没有快照（还没建过会话）给空数组，不抛", () => {
  assert.deepEqual(pluginServerRows(null), []);
  assert.deepEqual(pluginServerRows([]), []);
});
