import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSettingsTab, SETTINGS_TABS, visibleSettingsTabs } from "./settings-tabs.ts";

/**
 * 设置页签的出现条件：「插件」页签挂在实验功能 plugins 后面、「记忆库」页签挂在 memory-system 后面，
 * 开关开着才在；停在它上面时开关被关掉，退回「通用」。
 */

const ids = (flags: Parameters<typeof visibleSettingsTabs>[0]): string[] => visibleSettingsTabs(flags).map((tab) => tab.id);

describe("visibleSettingsTabs", () => {
  it("插件开关关着 / 缺省：没有「插件」页签，其余页签都在且顺序不变", () => {
    const expected = ["general", "providers", "migration", "browser", "voice", "experimental"];
    deepStrictEqual(ids({}), expected);
    deepStrictEqual(ids({ plugins: false }), expected);
  });

  it("插件开关开着：「插件」页签出现，排在「实验功能」之前", () => {
    const shown = ids({ plugins: true });
    strictEqual(shown.includes("plugins"), true);
    strictEqual(shown.indexOf("plugins") < shown.indexOf("experimental"), true);
    strictEqual(shown.length, SETTINGS_TABS.length - 1);
  });

  it("记忆系统开关开着：「记忆库」页签出现，紧挨在「插件」之后、「实验功能」之前", () => {
    const shown = ids({ "memory-system": true, plugins: true });
    strictEqual(shown.indexOf("memory"), shown.indexOf("plugins") + 1);
    strictEqual(shown.indexOf("memory") < shown.indexOf("experimental"), true);
    strictEqual(shown.length, SETTINGS_TABS.length);
    strictEqual(ids({ "memory-system": false }).includes("memory"), false);
    strictEqual(ids({}).includes("memory"), false);
  });

  it("别的实验开关不会带出这两个页签", () => {
    const shown = ids({ "intent-system": true });
    strictEqual(shown.includes("plugins"), false);
    strictEqual(shown.includes("memory"), false);
  });
});

describe("resolveSettingsTab", () => {
  it("可见的页签原样；停在「插件」上而开关被关：退回通用", () => {
    strictEqual(resolveSettingsTab("plugins", { plugins: true }), "plugins");
    strictEqual(resolveSettingsTab("plugins", { plugins: false }), "general");
    strictEqual(resolveSettingsTab("plugins", {}), "general");
    strictEqual(resolveSettingsTab("memory", { "memory-system": true }), "memory");
    strictEqual(resolveSettingsTab("memory", { "memory-system": false }), "general");
    strictEqual(resolveSettingsTab("memory", { plugins: true }), "general");
    strictEqual(resolveSettingsTab("providers", {}), "providers");
  });
});
