import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSideWidth,
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

describe("clampSideWidth：区间相对 chat 宽度（最小 1/3、最大 2/3）", () => {
  // T = 侧栏 + chat。w ≥ (T−w)/3 ⇔ w ≥ T/4；w ≤ 2(T−w)/3 ⇔ w ≤ 2T/5
  it("区间两端就是 T/4 与 2T/5，且换回 chat 正好是 1/3 与 2/3", () => {
    deepStrictEqual(clampSideWidth(300, 1200), 300);
    deepStrictEqual(clampSideWidth(480, 1200), 480);
    // 下端：chat = 1200 − 300 = 900，侧栏 300 = 900/3
    deepStrictEqual(300, (1200 - 300) / 3);
    // 上端：chat = 1200 − 480 = 720，侧栏 480 = 720 × 2/3
    deepStrictEqual(480, ((1200 - 480) * 2) / 3);
  });

  it("区间内原样收下并取整", () => {
    deepStrictEqual(clampSideWidth(320, 1200), 320);
    deepStrictEqual(clampSideWidth(320.4, 1200), 320);
  });

  it("越界两头都夹回来", () => {
    deepStrictEqual(clampSideWidth(100, 1200), 300);
    deepStrictEqual(clampSideWidth(900, 1200), 480);
  });

  it("窗口小到 T/4 落在地板以下时地板接管（上限仍按 2T/5）", () => {
    // T = 600：T/4 = 150 < 200 → 下界 200；上界 2T/5 = 240
    deepStrictEqual(clampSideWidth(100, 600), 200);
    deepStrictEqual(clampSideWidth(220, 600), 220);
    deepStrictEqual(clampSideWidth(300, 600), 240);
  });

  it("地板压过上限的退化情况：返回地板，宁可挤 chat 也不把侧栏收成一条线", () => {
    // T = 400：上界 2T/5 = 160 < 地板 200
    deepStrictEqual(clampSideWidth(320, 400), 200);
    deepStrictEqual(clampSideWidth(100, 400), 200);
  });

  it("量不到 T（元素未挂载）时只保地板，不拿假的 T 去夹", () => {
    deepStrictEqual(clampSideWidth(320, 0), 320);
    deepStrictEqual(clampSideWidth(100, 0), 200);
    deepStrictEqual(clampSideWidth(320, Number.NaN), 320);
  });

  it("非数的宽度退到地板，不把 NaN 传进样式", () => {
    deepStrictEqual(clampSideWidth(Number.NaN, 1200), 300);
  });
});

describe("parseSettings 的 sidebarWidth", () => {
  it("缺席 = 没拖过，不落这个键（默认宽度不写进用户的文件）", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }).sidebarWidth, undefined);
  });

  it("合法值收下并取整", () => {
    deepStrictEqual(parseSettings({ sidebarWidth: 320 }).sidebarWidth, 320);
    deepStrictEqual(parseSettings({ sidebarWidth: 301.6 }).sidebarWidth, 302);
  });

  // 上界依赖当前窗口宽度（clampSideWidth），存储层判不了：一个在 4K 屏上存下的
  // 700 在笔记本上越界，但它不是坏值——夹取交给渲染层每次渲染时做
  it("只拦 <200 的坏值，大值留着交给渲染层夹", () => {
    deepStrictEqual(parseSettings({ sidebarWidth: 200 }).sidebarWidth, 200);
    deepStrictEqual(parseSettings({ sidebarWidth: 199 }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: 120 }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: 4000 }).sidebarWidth, 4000);
  });

  it("非数一律丢掉", () => {
    deepStrictEqual(parseSettings({ sidebarWidth: "wide" }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: Number.NaN }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: null }).sidebarWidth, undefined);
  });

  it("坐错位置的宽度不串台：两个宽度各记各的", () => {
    const parsed = parseSettings({ sidebarWidth: 360, rightPanelWidth: 420 });
    deepStrictEqual(parsed.sidebarWidth, 360);
    deepStrictEqual(parsed.rightPanelWidth, 420);
  });
});

describe("parseSettings 的 rightPanelWidth", () => {
  it("缺席 = 没拖过，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }).rightPanelWidth, undefined);
  });

  it("同 sidebarWidth 的口径：只拦 <200，取整后收下", () => {
    deepStrictEqual(parseSettings({ rightPanelWidth: 200 }).rightPanelWidth, 200);
    deepStrictEqual(parseSettings({ rightPanelWidth: 411.4 }).rightPanelWidth, 411);
    deepStrictEqual(parseSettings({ rightPanelWidth: 150 }).rightPanelWidth, undefined);
    deepStrictEqual(parseSettings({ rightPanelWidth: 900 }).rightPanelWidth, 900);
    deepStrictEqual(parseSettings({ rightPanelWidth: "wide" }).rightPanelWidth, undefined);
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

  it("思考档跟着 lastUsed 走：合法保留（7 档全集），坏值整键丢弃", () => {
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { thinkingLevel: "high" } }).lastUsed,
      { thinkingLevel: "high" },
    );
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { thinkingLevel: "xhigh" } }).lastUsed,
      { thinkingLevel: "xhigh" },
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
