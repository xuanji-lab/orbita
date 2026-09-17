import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPACTION_DEFAULT,
  COMPACTION_PERCENT,
  DEFAULT_SETTINGS,
  parseSettings,
  THEME_PREFERENCES,
} from "./settings.ts";

describe("parseSettings", () => {
  it("四档主题都认（含 black 手动档）", () => {
    for (const theme of THEME_PREFERENCES) {
      deepStrictEqual(parseSettings({ theme }), { theme });
    }
  });

  it("默认是 system——没表态就跟着系统走", () => {
    deepStrictEqual(DEFAULT_SETTINGS.theme, "system");
    deepStrictEqual(parseSettings({}), DEFAULT_SETTINGS);
  });

  // 这个文件在用户目录里、手改得到：坏值不该让应用起不来，
  // 也不该把任意字符串流进渲染层的 data-theme
  it("不认识的主题名退回默认", () => {
    deepStrictEqual(parseSettings({ theme: "midnight" }), DEFAULT_SETTINGS);
    deepStrictEqual(parseSettings({ theme: 42 }), DEFAULT_SETTINGS);
    deepStrictEqual(parseSettings({ theme: null }), DEFAULT_SETTINGS);
  });

  it("整个文件坏掉也退回默认", () => {
    deepStrictEqual(parseSettings(null), DEFAULT_SETTINGS);
    deepStrictEqual(parseSettings("dark"), DEFAULT_SETTINGS);
    deepStrictEqual(parseSettings([]), DEFAULT_SETTINGS);
  });

  it("不认识的字段丢掉，不原样带过去", () => {
    deepStrictEqual(parseSettings({ theme: "dark", fontScale: 2, nested: { a: 1 } }), {
      theme: "dark",
    });
  });
});

describe("parseSettings 的 compaction（A-1）", () => {
  it("出厂默认：剩余 20%、自动压缩开", () => {
    deepStrictEqual(COMPACTION_DEFAULT, { reservePercent: 20, enabled: true });
  });

  it("缺席 = 用户从没动过它，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }), { theme: "dark" });
  });

  it("合法值原样收下", () => {
    deepStrictEqual(parseSettings({ compaction: { reservePercent: 10, enabled: false } }), {
      theme: "system",
      compaction: { reservePercent: 10, enabled: false },
    });
  });

  it("百分比越界回 20——手改出 200 等于上限的两倍才留余量，比坏主题更危险", () => {
    deepStrictEqual(parseSettings({ compaction: { reservePercent: 200, enabled: true } }), {
      theme: "system",
      compaction: { reservePercent: COMPACTION_DEFAULT.reservePercent, enabled: true },
    });
    deepStrictEqual(parseSettings({ compaction: { reservePercent: 0, enabled: true } }).compaction, {
      reservePercent: COMPACTION_DEFAULT.reservePercent,
      enabled: true,
    });
    // 区间端点是合法的
    deepStrictEqual(parseSettings({ compaction: { reservePercent: COMPACTION_PERCENT.min, enabled: true } }).compaction?.reservePercent, COMPACTION_PERCENT.min);
    deepStrictEqual(parseSettings({ compaction: { reservePercent: COMPACTION_PERCENT.max, enabled: true } }).compaction?.reservePercent, COMPACTION_PERCENT.max);
  });

  it("非数的百分比、非布尔的开关，逐字段回默认", () => {
    deepStrictEqual(parseSettings({ compaction: { reservePercent: "很多", enabled: "yes" } }).compaction, {
      reservePercent: COMPACTION_DEFAULT.reservePercent,
      enabled: true,
    });
  });

  it("整段不是对象 = 没动过", () => {
    deepStrictEqual(parseSettings({ compaction: "off" }), { theme: "system" });
    deepStrictEqual(parseSettings({ compaction: 42 }), { theme: "system" });
  });
});
