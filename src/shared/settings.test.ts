import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, DRAWER_WIDTH, parseSettings, THEME_PREFERENCES } from "./settings.ts";

describe("parseSettings", () => {
  it("四档主题都认（含 black 手动档）", () => {
    for (const theme of THEME_PREFERENCES) {
      deepStrictEqual(parseSettings({ theme }), { theme, drawer: DEFAULT_SETTINGS.drawer });
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
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });
});

describe("parseSettings: drawer 字段", () => {
  it("旧文件没有 drawer 字段：退回默认（收起 / 320 / 无停靠）", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }).drawer, DEFAULT_SETTINGS.drawer);
  });

  it("合法值原样保留；宽度取整", () => {
    const parsed = parseSettings({ drawer: { open: true, width: 412.7, docked: ["a", "b"] } });
    deepStrictEqual(parsed.drawer, { open: true, width: 413, docked: ["a", "b"] });
  });

  it("越界宽度不钳制、退回默认——钳制是渲染层拖拽的事，这里不猜", () => {
    deepStrictEqual(
      parseSettings({ drawer: { open: true, width: 99 } }).drawer.width,
      DRAWER_WIDTH.default,
    );
    deepStrictEqual(
      parseSettings({ drawer: { open: true, width: 9999 } }).drawer.width,
      DRAWER_WIDTH.default,
    );
  });

  it("坏值逐字段退回默认：非字符串的停靠 id 直接丢", () => {
    deepStrictEqual(parseSettings({ drawer: { open: "yes", width: "wide", docked: "all" } }).drawer, {
      open: false,
      width: DRAWER_WIDTH.default,
      docked: [],
    });
    deepStrictEqual(
      parseSettings({ drawer: { open: true, width: 380, docked: [1, "a", null] } }).drawer.docked,
      ["a"],
    );
  });

  it("drawer 整体不是对象：整体退回默认，theme 不受牵连", () => {
    const parsed = parseSettings({ theme: "light", drawer: "collapsed" });
    deepStrictEqual(parsed.theme, "light");
    deepStrictEqual(parsed.drawer, DEFAULT_SETTINGS.drawer);
  });
});
