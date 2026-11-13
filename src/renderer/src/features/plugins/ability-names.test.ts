import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

describe("面板改名：插件面板对用户叫「能力」（只改面板名，每一项仍按自己的种类叫）", () => {
  test("右栏入口、面板标题、设置里的页签、面板名表：中文「能力」，英文 Abilities", () => {
    for (const [messages, name] of [[zh, "能力"], [en, "Abilities"]] as const) {
      assert.equal(messages.rail.plugins, name);
      assert.equal(messages.plugins.title, name);
      assert.equal(messages.plugins.backToInstalled, name);
      assert.equal(messages.settings.tabs.plugins, name);
    }
  });

  test("列表行右侧的种类小标仍是 插件 / 内置 / 技能 / MCP；「和智能体一起做一个插件」这类插件自己的文案不变", () => {
    assert.deepEqual(zh.plugins.rowKind, { plugin: "插件", builtin: "内置", skill: "技能", mcp: "MCP" });
    assert.deepEqual(en.plugins.rowKind, { plugin: "Plugin", builtin: "Built-in", skill: "Skill", mcp: "MCP" });
    assert.match(zh.plugins.makeWithAgentTip, /插件/);
    assert.match(zh.plugins.makeWithAgentDraft, /插件/);
    assert.match(zh.plugins.uninstallHint, /插件/);
    assert.match(en.plugins.makeWithAgentTip, /plugin/);
  });

  test("两种语言的新文案都有（零散技能 / MCP 详情）", () => {
    for (const messages of [zh, en]) {
      const p = messages.plugins;
      for (const text of [p.contentTitle, p.availableTitle, p.availableGlobal, p.mcpStatusTitle, p.mcpEnabled, p.mcpRetry, p.mcpReconnect, p.mcpCommandTitle, p.skillMissingClean, p.revealInManager("finder")]) {
        assert.notEqual(text, "");
      }
      for (const kind of ["ready", "connecting", "failed", "idle", "disabled"] as const) assert.notEqual(p.mcpState[kind], "");
      assert.notEqual(p.mcpToolsTitle(3), "");
      assert.notEqual(p.problem["skill-folder-missing"]("x"), "");
    }
    for (const messages of [zh, en]) {
      const p = messages.plugins;
      for (const text of [p.skillArchive, p.skillTrash, p.skillArchiveAction, p.skillTrashAction, p.archivedRestore, p.skillArchiveHint, p.skillTrashHint("finder")]) assert.notEqual(text, "");
      assert.notEqual(p.archivedTitle(3), "");
      assert.notEqual(p.skillTrashHintLinked("/x"), "");
      assert.notEqual(p.archivedExists("s"), "");
    }
    // 移除的确认条要写清「移到废纸篓、可以找回」
    assert.match(zh.plugins.skillTrashHint("finder"), /废纸篓.*找回/);
    assert.equal(zh.plugins.availableTitle, "在哪儿可用");
    assert.equal(zh.plugins.mcpToolsTitle(3), "工具 3");
  });
});
