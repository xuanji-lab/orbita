import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPACTION_DEFAULT,
  COMPACTION_PERCENT,
  DEFAULT_SETTINGS,
  DRAWER_WIDTH,
  parseSettings,
  THEME_PREFERENCES,
} from "./settings.ts";

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
    const parsed = parseSettings({ drawer: { width: 412.7, docked: ["a", "b"] } });
    deepStrictEqual(parsed.drawer, { width: 413, docked: ["a", "b"] });
  });

  it("越界宽度不钳制、退回默认——钳制是渲染层拖拽的事，这里不猜", () => {
    deepStrictEqual(
      parseSettings({ drawer: { width: 99 } }).drawer.width,
      DRAWER_WIDTH.default,
    );
    deepStrictEqual(
      parseSettings({ drawer: { width: 9999 } }).drawer.width,
      DRAWER_WIDTH.default,
    );
  });

  it("坏值逐字段退回默认：非字符串的停靠 id 直接丢", () => {
    deepStrictEqual(parseSettings({ drawer: { width: "wide", docked: "all" } }).drawer, {
      width: DRAWER_WIDTH.default,
      docked: [],
    });
    deepStrictEqual(
      parseSettings({ drawer: { width: 380, docked: [1, "a", null] } }).drawer.docked,
      ["a"],
    );
  });

  it("drawer 整体不是对象：整体退回默认，theme 不受牵连", () => {
    const parsed = parseSettings({ theme: "light", drawer: "collapsed" });
    deepStrictEqual(parsed.theme, "light");
    deepStrictEqual(parsed.drawer, DEFAULT_SETTINGS.drawer);
  });
});

describe("parseSettings 的 compaction（A-1）", () => {
  it("出厂默认：剩余 20%、自动压缩开", () => {
    deepStrictEqual(COMPACTION_DEFAULT, { reservePercent: 20, enabled: true });
  });

  it("缺席 = 用户从没动过它，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }), {
      theme: "dark",
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });

  it("合法值原样收下", () => {
    deepStrictEqual(parseSettings({ compaction: { reservePercent: 10, enabled: false } }), {
      theme: "system",
      drawer: DEFAULT_SETTINGS.drawer,
      compaction: { reservePercent: 10, enabled: false },
    });
  });

  it("百分比越界回 20——手改出 200 等于上限的两倍才留余量，比坏主题更危险", () => {
    deepStrictEqual(parseSettings({ compaction: { reservePercent: 200, enabled: true } }), {
      theme: "system",
      drawer: DEFAULT_SETTINGS.drawer,
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
    deepStrictEqual(parseSettings({ compaction: "off" }), {
      theme: "system",
      drawer: DEFAULT_SETTINGS.drawer,
    });
    deepStrictEqual(parseSettings({ compaction: 42 }), {
      theme: "system",
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });
});

describe("parseSettings 的 gitAttribution", () => {
  it("缺席 = 开启，且不落这个键——默认值不写进用户的文件", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }), {
      theme: "dark",
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });

  it("true / false 都原样保留", () => {
    deepStrictEqual(parseSettings({ gitAttribution: true }).gitAttribution, true);
    deepStrictEqual(parseSettings({ gitAttribution: false }).gitAttribution, false);
  });

  it("非布尔一律丢掉，不当成真——手改出的 \"yes\" 不该变成一个开着的开关", () => {
    deepStrictEqual(parseSettings({ gitAttribution: "yes" }).gitAttribution, undefined);
    deepStrictEqual(parseSettings({ gitAttribution: 1 }).gitAttribution, undefined);
    deepStrictEqual(parseSettings({ gitAttribution: null }).gitAttribution, undefined);
  });
});

describe("parseSettings 的 titleModel", () => {
  it("缺席 = 用会话当前的模型，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }).titleModel, undefined);
  });

  it("两个 id 都在就原样收下", () => {
    deepStrictEqual(
      parseSettings({ titleModel: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" } })
        .titleModel,
      { providerId: "zhipu-coding", modelId: "glm-5.3-flash" },
    );
  });

  it("存半截的丢掉——光有 modelId 定位不到密钥，光有 providerId 不知道叫哪个模型", () => {
    deepStrictEqual(parseSettings({ titleModel: { modelId: "glm-5.3-flash" } }).titleModel, undefined);
    deepStrictEqual(parseSettings({ titleModel: { providerId: "zhipu-coding" } }).titleModel, undefined);
    deepStrictEqual(
      parseSettings({ titleModel: { providerId: "", modelId: "m" } }).titleModel,
      undefined,
    );
  });

  it("坏值与非对象一律当没指定", () => {
    deepStrictEqual(parseSettings({ titleModel: { providerId: 1, modelId: 2 } }).titleModel, undefined);
    deepStrictEqual(parseSettings({ titleModel: "fast" }).titleModel, undefined);
    deepStrictEqual(parseSettings({ titleModel: null }).titleModel, undefined);
  });
});

describe("parseSettings 的 lastUsed（A-0 复验 bug A：重启忘了上次选择）", () => {
  it("完整 lastUsed 保留", () => {
    deepStrictEqual(
      parseSettings({
        theme: "system",
        lastUsed: { mode: "skip", providerId: "zhipu-coding", modelId: "glm-5.3-flash" },
      }).lastUsed,
      { mode: "skip", providerId: "zhipu-coding", modelId: "glm-5.3-flash" },
    );
  });

  it("思考档跟着 lastUsed 走：合法保留，坏值（含 pi 的 xhigh/max）整键丢弃", () => {
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { thinkingLevel: "high" } }).lastUsed,
      { thinkingLevel: "high" },
    );
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { thinkingLevel: "xhigh" } }).lastUsed,
      undefined,
    );
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { thinkingLevel: "turbo" } }).lastUsed,
      undefined,
    );
  });

  it("坏 mode 丢 mode 留 id；键全无效 = 整段不落盘", () => {
    deepStrictEqual(
      parseSettings({
        theme: "system",
        lastUsed: { mode: "yolo", providerId: "p", modelId: "m" },
      }).lastUsed,
      { providerId: "p", modelId: "m" },
    );
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { mode: "yolo", providerId: 42 } }).lastUsed,
      undefined,
    );
    deepStrictEqual(parseSettings({ theme: "system", lastUsed: {} }).lastUsed, undefined);
  });
});
