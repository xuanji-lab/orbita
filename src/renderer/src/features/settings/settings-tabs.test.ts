import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { GUIDE } from "../onboarding/onboarding-pages.ts";
import { SETTINGS_TABS } from "./settings-tabs.ts";

describe("设置页签：新手引导是「通用」之后的独立一页", () => {
  test("登记在 general 之后第二个位置，图标走 FEATURE_ICON", () => {
    assert.deepEqual(SETTINGS_TABS.slice(0, 2).map((tab) => tab.id), ["general", "guide"]);
    assert.equal(SETTINGS_TABS[1]?.icon, FEATURE_ICON.guide);
  });

  test("每个页签中英都有名字；新手引导 = 「新手引导」/ Guide", () => {
    for (const tab of SETTINGS_TABS) {
      assert.ok(zh.settings.tabs[tab.id] !== "", `zh 缺 ${tab.id}`);
      assert.ok(en.settings.tabs[tab.id] !== "", `en 缺 ${tab.id}`);
    }
    assert.equal(zh.settings.tabs.guide, "新手引导");
    assert.equal(en.settings.tabs.guide, "Guide");
  });

  test("页签文案齐：从头看 / 已看过 · 可随时重看（中英）", () => {
    assert.equal(zh.settings.guideStart, "从头看");
    assert.equal(zh.settings.guideSeen, "已看过 · 可随时重看");
    assert.ok(en.settings.guideStart !== "" && en.settings.guideSeen !== "");
    assert.ok(zh.settings.guideChapterOpen("开始").includes("开始"));
  });

  test("每章都有一句话简介（页签目录用），中英都不空、不换行", () => {
    for (const chapter of GUIDE) {
      for (const [lang, table] of [["zh", zh], ["en", en]] as const) {
        const blurb = table.onboarding.chapters[chapter.id].blurb;
        assert.ok(blurb !== "" && !blurb.includes("\n"), `${lang} ${chapter.id} 简介`);
      }
    }
  });

  test("「通用」里原来那行「再看一遍」已移除：入口只留新页签一处", () => {
    const view = readFileSync(new URL("./SettingsView.tsx", import.meta.url), "utf8");
    assert.ok(!view.includes("onboardingReplay"));
    assert.ok(!view.includes("t.settings.onboarding"));
    assert.ok(view.includes("<GuideSettings"));
    assert.equal(Object.keys(zh.settings).includes("onboardingReplay"), false);
  });
});
