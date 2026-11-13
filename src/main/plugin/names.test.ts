import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isMcpServerName, parseQualifiedToolName, qualifiedToolName } from "../../shared/mcp.ts";
import { nameSegment, qualifiedPluginServerName } from "./names.ts";

describe("qualifiedPluginServerName", () => {
  test("plugin_<插件>_<服务>，点号等非法字符规整成下划线", () => {
    assert.equal(qualifiedPluginServerName("pdf", "viewer"), "plugin_pdf_viewer");
    assert.equal(qualifiedPluginServerName("my.plugin", "image search"), "plugin_my_plugin_image_search");
  });

  test("结果始终满足 isMcpServerName，工具名拆得回服务名", () => {
    for (const [plugin, server] of [["a.b", "c.d"], ["x", "weird 名字"], ["p", ""], ["p-1", "s__t"], ["x".repeat(64), "y".repeat(64)]] as const) {
      const name = qualifiedPluginServerName(plugin, server);
      assert.equal(isMcpServerName(name), true, name);
      assert.deepEqual(parseQualifiedToolName(qualifiedToolName(name, "tool")), { server: name, tool: "tool" });
    }
  });

  test("连续下划线收成一个：__ 是服务与工具的分隔符，不能留在名字里", () => {
    assert.equal(qualifiedPluginServerName("a__b", "c___d").includes("__"), false);
    assert.equal(nameSegment("a__b"), "a_b");
  });

  test("超长时截短并附哈希：稳定，且被截成同一前缀的两对仍不撞", () => {
    const longA = "a".repeat(40);
    const one = qualifiedPluginServerName(longA, "s".repeat(40));
    const again = qualifiedPluginServerName(longA, "s".repeat(40));
    const other = qualifiedPluginServerName(longA, "s".repeat(39) + "t");
    assert.equal(one, again);
    assert.ok(one.length <= 64);
    assert.notEqual(one, other);
  });

  test("规整可能让不同原名撞名（a.b 与 a_b）——这是安装时查重要兜的", () => {
    assert.equal(qualifiedPluginServerName("a.b", "s"), qualifiedPluginServerName("a_b", "s"));
  });

  test("空段、段首段尾的下划线都不产出 __", () => {
    assert.equal(qualifiedPluginServerName("p", "..."), "plugin_p_x");
    assert.equal(qualifiedPluginServerName("p", "_lead"), "plugin_p_lead");
    assert.equal(qualifiedPluginServerName("p", "tail."), "plugin_p_tail");
  });
});
