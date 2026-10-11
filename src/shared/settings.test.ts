import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  effectiveLanguage,
  selectableThemes,
  themeLanguage,
  CHANNEL_COLUMN_WIDTH_DEFAULT,
  clampChannelColumnWidth,
  clampRightPanelWidth,
  COMPACTION_DEFAULT,
  COMPACTION_PERCENT,
  DEFAULT_SETTINGS,
  DRAWER_WIDTH,
  parseSettings,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
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

  it("改名前的旧 id manuscript 落回 copybook，不退回 system", () => {
    deepStrictEqual(parseSettings({ theme: "manuscript" }), { theme: "copybook", drawer: DEFAULT_SETTINGS.drawer });
  });

  it("退役档 dark（Warm）迁移到 graphite——同为「不近黑的暗档」的继任", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }), { theme: "graphite", drawer: DEFAULT_SETTINGS.drawer });
  });

  it("整个文件坏掉也退回默认", () => {
    deepStrictEqual(parseSettings(null), DEFAULT_SETTINGS);
    deepStrictEqual(parseSettings("dark"), DEFAULT_SETTINGS);
    deepStrictEqual(parseSettings([]), DEFAULT_SETTINGS);
  });

  it("不认识的字段丢掉，不原样带过去", () => {
    deepStrictEqual(parseSettings({ theme: "graphite", fontScale: 2, nested: { a: 1 } }), {
      theme: "graphite",
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });
});

describe("parseSettings: drawer 字段", () => {
  it("旧文件没有 drawer 字段：退回默认（收起 / 320 / 无停靠）", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }).drawer, DEFAULT_SETTINGS.drawer);
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

describe("clampRightPanelWidth：区间是 pane 的 1/3–2/3（P = chat 主区 + 右栏）", () => {
  // 2026-09-22 wafo 澄清：这条比例规则只管 chat 与右栏这一对，左侧栏不在其中
  it("区间两端就是 P/3 与 2P/3", () => {
    deepStrictEqual(clampRightPanelWidth(400, 1200), 400);
    deepStrictEqual(clampRightPanelWidth(800, 1200), 800);
    // 下端：右栏 400 = P/3，chat 拿走剩下的 800
    deepStrictEqual(400, 1200 / 3);
    // 上端：右栏 800 = 2P/3，chat 只剩 400
    deepStrictEqual(800, (1200 * 2) / 3);
  });

  it("区间内原样收下并取整", () => {
    deepStrictEqual(clampRightPanelWidth(500, 1200), 500);
    deepStrictEqual(clampRightPanelWidth(500.4, 1200), 500);
  });

  it("越界两头都夹回来", () => {
    deepStrictEqual(clampRightPanelWidth(320, 1200), 400);
    deepStrictEqual(clampRightPanelWidth(1100, 1200), 800);
  });

  it("pane 小到 P/3 落在地板以下时地板接管（上限仍按 2P/3）", () => {
    // P = 540：P/3 = 180 < 200 → 下界 200；上界 2P/3 = 360
    deepStrictEqual(clampRightPanelWidth(100, 540), 200);
    deepStrictEqual(clampRightPanelWidth(320, 540), 320);
    deepStrictEqual(clampRightPanelWidth(500, 540), 360);
  });

  it("地板压过上限的退化情况：返回地板，宁可挤 chat 也不把右栏收成一条线", () => {
    // P = 270：上界 2P/3 = 180 < 地板 200
    deepStrictEqual(clampRightPanelWidth(320, 270), 200);
    deepStrictEqual(clampRightPanelWidth(100, 270), 200);
  });

  it("量不到 P（元素未挂载）时只保地板，不拿假的 P 去夹", () => {
    deepStrictEqual(clampRightPanelWidth(320, 0), 320);
    deepStrictEqual(clampRightPanelWidth(100, 0), 200);
    deepStrictEqual(clampRightPanelWidth(320, Number.NaN), 320);
  });

  it("非数的宽度退到地板，再按 P 夹", () => {
    deepStrictEqual(clampRightPanelWidth(Number.NaN, 1200), 400);
  });
});

describe("parseSettings 的 sidebarWidth", () => {
  it("缺席 = 没拖过，不落这个键（默认宽度不写进用户的文件）", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }).sidebarWidth, undefined);
  });

  it("合法值收下并取整", () => {
    deepStrictEqual(parseSettings({ sidebarWidth: 320 }).sidebarWidth, 320);
    deepStrictEqual(parseSettings({ sidebarWidth: 301.6 }).sidebarWidth, 302);
  });

  // 左栏的区间是固定像素，存储层判得了：这个文件用户手改得到，
  // 一个 4000 该被丢掉，而不是被「猜」成 400
  it("区间 240–400 之外一律丢掉，不钳制", () => {
    deepStrictEqual(parseSettings({ sidebarWidth: SIDEBAR_WIDTH_MIN }).sidebarWidth, 240);
    deepStrictEqual(parseSettings({ sidebarWidth: SIDEBAR_WIDTH_MAX }).sidebarWidth, 400);
    deepStrictEqual(parseSettings({ sidebarWidth: 239 }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: 401 }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: 4000 }).sidebarWidth, undefined);
  });

  it("非数一律丢掉", () => {
    deepStrictEqual(parseSettings({ sidebarWidth: "wide" }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: Number.NaN }).sidebarWidth, undefined);
    deepStrictEqual(parseSettings({ sidebarWidth: null }).sidebarWidth, undefined);
  });

  it("坐错位置的宽度不串台：两个宽度各记各的（区间也各是各的）", () => {
    const parsed = parseSettings({ sidebarWidth: 360, rightPanelWidth: 420 });
    deepStrictEqual(parsed.sidebarWidth, 360);
    deepStrictEqual(parsed.rightPanelWidth, 420);
  });
});

describe("parseSettings 的 rightPanelWidth", () => {
  it("缺席 = 没拖过，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }).rightPanelWidth, undefined);
  });

  // 右栏的上界依赖当前 pane 宽度（clampRightPanelWidth），存储层判不了：
  // 一个在 4K 屏上存下的 900 在笔记本上越界，但它不是坏值——夹取交给渲染层
  it("只拦 <200 的坏值，大值留着交给渲染层夹", () => {
    deepStrictEqual(parseSettings({ rightPanelWidth: 200 }).rightPanelWidth, 200);
    deepStrictEqual(parseSettings({ rightPanelWidth: 411.4 }).rightPanelWidth, 411);
    deepStrictEqual(parseSettings({ rightPanelWidth: 150 }).rightPanelWidth, undefined);
    deepStrictEqual(parseSettings({ rightPanelWidth: 900 }).rightPanelWidth, 900);
    deepStrictEqual(parseSettings({ rightPanelWidth: "wide" }).rightPanelWidth, undefined);
  });
});

describe("parseSettings 的 channelColumnWidth（子会话 2026-09-23：通道列可拖宽）", () => {
  it("缺席 = 没拖过，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }).channelColumnWidth, undefined);
  });

  // 上界依赖当前 chat 区宽度（clampChannelColumnWidth），存储层判不了：同 rightPanelWidth 的纪律
  it("只拦 <180 的坏值，大值留着交给渲染层夹", () => {
    deepStrictEqual(parseSettings({ channelColumnWidth: 180 }).channelColumnWidth, 180);
    deepStrictEqual(parseSettings({ channelColumnWidth: 240.4 }).channelColumnWidth, 240);
    deepStrictEqual(parseSettings({ channelColumnWidth: 179 }).channelColumnWidth, undefined);
    deepStrictEqual(parseSettings({ channelColumnWidth: 900 }).channelColumnWidth, 900);
    deepStrictEqual(parseSettings({ channelColumnWidth: "wide" }).channelColumnWidth, undefined);
    deepStrictEqual(parseSettings({ channelColumnWidth: Number.NaN }).channelColumnWidth, undefined);
  });
});

describe("clampChannelColumnWidth：区间是 chat 区（主槽 + 通道列）的 1/6–1/3", () => {
  it("默认值是 300", () => {
    deepStrictEqual(CHANNEL_COLUMN_WIDTH_DEFAULT, 300);
  });

  it("区间两端就是 C/6 与 C/3", () => {
    deepStrictEqual(clampChannelColumnWidth(200, 1200), 200);
    deepStrictEqual(clampChannelColumnWidth(400, 1200), 400);
    deepStrictEqual(200, 1200 / 6);
    deepStrictEqual(400, 1200 / 3);
  });

  it("区间内原样收下并取整", () => {
    deepStrictEqual(clampChannelColumnWidth(300, 1200), 300);
    deepStrictEqual(clampChannelColumnWidth(300.6, 1200), 301);
  });

  it("越界两头都夹回来", () => {
    deepStrictEqual(clampChannelColumnWidth(100, 1200), 200);
    deepStrictEqual(clampChannelColumnWidth(500, 1200), 400);
  });

  it("chat 区小到 C/6 落在地板以下时地板接管（上限仍按 C/3）", () => {
    // C = 900：C/6 = 150 < 180 → 下界 180；上界 C/3 = 300
    deepStrictEqual(clampChannelColumnWidth(100, 900), 180);
    deepStrictEqual(clampChannelColumnWidth(250, 900), 250);
    deepStrictEqual(clampChannelColumnWidth(500, 900), 300);
  });

  it("地板压过上限的退化情况：返回地板，宁可挤主槽也不把通道列收成一条线", () => {
    // C = 480：上界 C/3 = 160 < 地板 180
    deepStrictEqual(clampChannelColumnWidth(300, 480), 180);
    deepStrictEqual(clampChannelColumnWidth(100, 480), 180);
  });

  it("量不到 C（元素未挂载）时只保地板，不拿假的 C 去夹", () => {
    deepStrictEqual(clampChannelColumnWidth(300, 0), 300);
    deepStrictEqual(clampChannelColumnWidth(100, 0), 180);
    deepStrictEqual(clampChannelColumnWidth(300, Number.NaN), 300);
  });

  it("非数的宽度退到地板，再按 C 夹", () => {
    deepStrictEqual(clampChannelColumnWidth(Number.NaN, 1200), 200);
  });
});

describe("parseSettings 的 compaction（A-1）", () => {
  it("出厂默认：剩余 20%、自动压缩开", () => {
    deepStrictEqual(COMPACTION_DEFAULT, { reservePercent: 20, enabled: true });
  });

  it("缺席 = 用户从没动过它，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }), {
      theme: "graphite",
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
    deepStrictEqual(parseSettings({ theme: "graphite" }), {
      theme: "graphite",
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

describe("parseSettings 的 collapsePastedText", () => {
  it("缺席 = 折叠（不落键，同 gitAttribution 的纪律）", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }), {
      theme: "graphite",
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });

  it("true / false 都原样保留", () => {
    deepStrictEqual(parseSettings({ collapsePastedText: true }).collapsePastedText, true);
    deepStrictEqual(parseSettings({ collapsePastedText: false }).collapsePastedText, false);
  });

  it("非布尔一律丢掉，不当成真", () => {
    deepStrictEqual(parseSettings({ collapsePastedText: "yes" }).collapsePastedText, undefined);
    deepStrictEqual(parseSettings({ collapsePastedText: 1 }).collapsePastedText, undefined);
    deepStrictEqual(parseSettings({ collapsePastedText: null }).collapsePastedText, undefined);
  });
});

describe("parseSettings 的 composerBlackhole", () => {
  it("缺席 = 关（不落键）", () => {
    deepStrictEqual(parseSettings({ theme: "light" }), {
      theme: "light",
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });

  it("true / false 都原样保留", () => {
    deepStrictEqual(parseSettings({ composerBlackhole: true }).composerBlackhole, true);
    deepStrictEqual(parseSettings({ composerBlackhole: false }).composerBlackhole, false);
  });

  it("非布尔一律丢掉，不当成真", () => {
    deepStrictEqual(parseSettings({ composerBlackhole: "on" }).composerBlackhole, undefined);
    deepStrictEqual(parseSettings({ composerBlackhole: 1 }).composerBlackhole, undefined);
    deepStrictEqual(parseSettings({ composerBlackhole: null }).composerBlackhole, undefined);
  });
});

describe("parseSettings 的 choreModel", () => {
  it("缺席 = 各件家务退回会话模型，不落这个键", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }).choreModel, undefined);
  });

  it("两个 id 都在就原样收下", () => {
    deepStrictEqual(
      parseSettings({ choreModel: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" } })
        .choreModel,
      { providerId: "zhipu-coding", modelId: "glm-5.3-flash" },
    );
  });

  it("旧键 titleModel（只管起名的时代）在 choreModel 缺席时接着用，选过的用户不用重选", () => {
    deepStrictEqual(
      parseSettings({ titleModel: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" } })
        .choreModel,
      { providerId: "zhipu-coding", modelId: "glm-5.3-flash" },
    );
    // 新键在就不再看旧键（同一对象里两者都有：新键赢）
    deepStrictEqual(
      parseSettings({
        choreModel: { providerId: "kimi", modelId: "kimi-k3" },
        titleModel: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" },
      }).choreModel,
      { providerId: "kimi", modelId: "kimi-k3" },
    );
  });

  it("存半截的丢掉——光有 modelId 定位不到密钥，光有 providerId 不知道叫哪个模型", () => {
    deepStrictEqual(parseSettings({ choreModel: { modelId: "glm-5.3-flash" } }).choreModel, undefined);
    deepStrictEqual(parseSettings({ choreModel: { providerId: "zhipu-coding" } }).choreModel, undefined);
    deepStrictEqual(
      parseSettings({ choreModel: { providerId: "", modelId: "m" } }).choreModel,
      undefined,
    );
  });

  it("坏值与非对象一律当没指定", () => {
    deepStrictEqual(parseSettings({ choreModel: { providerId: 1, modelId: 2 } }).choreModel, undefined);
    deepStrictEqual(parseSettings({ choreModel: "fast" }).choreModel, undefined);
    deepStrictEqual(parseSettings({ choreModel: null }).choreModel, undefined);
  });
});

describe("parseSettings 的 subSessionModel / subSessionThinking（子会话 2026-09-23）", () => {
  it("缺席 = 同父（不落键）——默认就是跟着父会话走", () => {
    deepStrictEqual(parseSettings({ theme: "graphite" }).subSessionModel, undefined);
    deepStrictEqual(parseSettings({ theme: "graphite" }).subSessionThinking, undefined);
    deepStrictEqual(DEFAULT_SETTINGS.subSessionModel, undefined);
    deepStrictEqual(DEFAULT_SETTINGS.subSessionThinking, undefined);
  });

  it("成对的模型 id 与合法思考档原样收下", () => {
    const model = { providerId: "zai", modelId: "glm-5.3-flash" };
    deepStrictEqual(parseSettings({ subSessionModel: model }).subSessionModel, model);
    deepStrictEqual(
      parseSettings({ subSessionModel: model, subSessionThinking: "high" }).subSessionThinking,
      "high",
    );
  });

  it("思考档绑定模型：模型是同父（缺席或半截）时单独一档思考丢掉——档位因模型而异，脱离模型就是假选项", () => {
    deepStrictEqual(parseSettings({ subSessionThinking: "high" }).subSessionThinking, undefined);
    deepStrictEqual(
      parseSettings({ subSessionModel: { modelId: "glm-5.3-flash" }, subSessionThinking: "high" })
        .subSessionThinking,
      undefined,
    );
  });

  it("半截模型与坏档位丢弃——优先级链（delegate 参数 > 这里 > 同父）只会退到同父，不会拿半截值去解析", () => {
    deepStrictEqual(parseSettings({ subSessionModel: { modelId: "glm-5.3-flash" } }).subSessionModel, undefined);
    deepStrictEqual(parseSettings({ subSessionModel: { providerId: "zai" } }).subSessionModel, undefined);
    deepStrictEqual(parseSettings({ subSessionModel: "fast" }).subSessionModel, undefined);
    const model = { providerId: "zai", modelId: "glm-5.3-flash" };
    deepStrictEqual(parseSettings({ subSessionModel: model, subSessionThinking: "turbo" }).subSessionThinking, undefined);
    deepStrictEqual(parseSettings({ subSessionModel: model, subSessionThinking: 3 }).subSessionThinking, undefined);
  });

  it("null 清除：parseSettings 自然丢掉——设置页「Same as parent」就靠这个退回默认", () => {
    deepStrictEqual(parseSettings({ subSessionModel: null }).subSessionModel, undefined);
    deepStrictEqual(parseSettings({ subSessionThinking: null }).subSessionThinking, undefined);
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

  it("思考档不跨重启：旧文件里的 lastUsed.thinkingLevel 读进来就丢（重启落模型默认档，wafo 2026-09-23）", () => {
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { thinkingLevel: "high" } }).lastUsed,
      undefined,
    );
    deepStrictEqual(
      parseSettings({ theme: "system", lastUsed: { mode: "skip", thinkingLevel: "xhigh" } }).lastUsed,
      { mode: "skip" },
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

describe("界面语言", () => {
  it("单语主题说了算：小学作业恒中文、打字稿恒英文，不管设置", () => {
    deepStrictEqual(effectiveLanguage("copybook", "en"), "zh");
    deepStrictEqual(effectiveLanguage("typescript", "zh"), "en");
    deepStrictEqual(themeLanguage("copybook"), "zh");
    deepStrictEqual(themeLanguage("typescript"), "en");
  });

  it("双语主题听设置；没设过是英文（语言设置之前的行为）", () => {
    for (const theme of ["system", "light", "graphite", "black"] as const) {
      deepStrictEqual(themeLanguage(theme), null);
      deepStrictEqual(effectiveLanguage(theme, "zh"), "zh");
      deepStrictEqual(effectiveLanguage(theme, undefined), "en");
    }
  });

  it("磁盘上的 language：认识的留下，坏值丢掉当没选过", () => {
    deepStrictEqual(parseSettings({ language: "zh" }).language, "zh");
    deepStrictEqual("language" in parseSettings({ language: "fr" }), false);
    deepStrictEqual("language" in parseSettings({}), false);
  });
});

describe("parseSettings 的 browserDownloadDir（受管浏览器下载目录）", () => {
  it("终对路径留下：POSIX、Windows 盘符、UNC", () => {
    deepStrictEqual(parseSettings({ browserDownloadDir: "/Users/me/Papers" }).browserDownloadDir, "/Users/me/Papers");
    deepStrictEqual(parseSettings({ browserDownloadDir: "C:\\Users\\me\\Papers" }).browserDownloadDir, "C:\\Users\\me\\Papers");
    deepStrictEqual(parseSettings({ browserDownloadDir: "\\\\nas\\share" }).browserDownloadDir, "\\\\nas\\share");
  });
  it("缺席、相对路径、非字符串都当没设（主进程退回系统下载文件夹）", () => {
    deepStrictEqual(parseSettings({ theme: "dark" }).browserDownloadDir, undefined);
    deepStrictEqual(parseSettings({ browserDownloadDir: "Papers" }).browserDownloadDir, undefined);
    deepStrictEqual(parseSettings({ browserDownloadDir: 42 }).browserDownloadDir, undefined);
  });
});

describe("parseSettings 的 starredModels（模型星标）", () => {
  it("成对的留下，顺序照旧", () => {
    deepStrictEqual(
      parseSettings({
        starredModels: [
          { providerId: "deepseek", modelId: "deepseek-v4-flash" },
          { providerId: "zhipu", modelId: "glm-5.3" },
        ],
      }).starredModels,
      [
        { providerId: "deepseek", modelId: "deepseek-v4-flash" },
        { providerId: "zhipu", modelId: "glm-5.3" },
      ],
    );
  });

  it("同一对只留一条：星标是开关，重复项会让取消星算错", () => {
    deepStrictEqual(
      parseSettings({
        starredModels: [
          { providerId: "zhipu", modelId: "glm-5.3" },
          { providerId: "zhipu", modelId: "glm-5.3" },
        ],
      }).starredModels,
      [{ providerId: "zhipu", modelId: "glm-5.3" }],
    );
  });

  it("坏项丢掉：缺一个 id、空串、非对象都不进库", () => {
    deepStrictEqual(
      parseSettings({
        starredModels: [
          { providerId: "zhipu" },
          { providerId: "", modelId: "glm-5.3" },
          null,
          "glm-5.3",
          { providerId: "zhipu", modelId: "glm-5.3" },
        ],
      }).starredModels,
      [{ providerId: "zhipu", modelId: "glm-5.3" }],
    );
  });

  it("空数组与全无效都是「没有星标」：键不落盘，不为此留一个空数组", () => {
    deepStrictEqual("starredModels" in parseSettings({ starredModels: [] }), false);
    deepStrictEqual("starredModels" in parseSettings({ starredModels: [null, 7] }), false);
    deepStrictEqual("starredModels" in parseSettings({ starredModels: "zhipu" }), false);
    deepStrictEqual("starredModels" in parseSettings({}), false);
  });
});

describe("parseSettings 的 providerCardSize（模型服务的卡片尺寸）", () => {
  it("large / small 留下，其余当没选过（缺席 = large）", () => {
    deepStrictEqual(parseSettings({ providerCardSize: "small" }).providerCardSize, "small");
    deepStrictEqual(parseSettings({ providerCardSize: "large" }).providerCardSize, "large");
    deepStrictEqual("providerCardSize" in parseSettings({ providerCardSize: "huge" }), false);
    deepStrictEqual("providerCardSize" in parseSettings({}), false);
  });
});

describe("parseSettings 的 experimental（实验功能总开关）", () => {
  it("缺席 = 键不在：默认关，不带一个显式的 false 进盘", () => {
    deepStrictEqual("experimental" in parseSettings({}), false);
  });

  it("显式 true / false 都认", () => {
    deepStrictEqual(parseSettings({ experimental: true }).experimental, true);
    deepStrictEqual(parseSettings({ experimental: false }).experimental, false);
  });

  it("非布尔丢掉（手改得出 \"yes\"，该被丢而不是当成真）", () => {
    deepStrictEqual("experimental" in parseSettings({ experimental: "yes" }), false);
    deepStrictEqual("experimental" in parseSettings({ experimental: 1 }), false);
    deepStrictEqual("experimental" in parseSettings({ experimental: null }), false);
  });
});

describe("selectableThemes（主题选择卡的可选档位）", () => {
  it("实验开关开着：全六档都可选", () => {
    deepStrictEqual(selectableThemes(true), THEME_PREFERENCES);
  });

  it("实验开关关着：纸面两档（copybook / typescript）不出现", () => {
    deepStrictEqual(selectableThemes(false), ["system", "light", "graphite", "black"]);
  });

  it("过滤只动选择卡：已存的 copybook 仍被 parseTheme 认（照常应用，只是不再可选）", () => {
    deepStrictEqual(parseSettings({ theme: "copybook" }).theme, "copybook");
    ok(selectableThemes(false).includes(parseSettings({ theme: "copybook" }).theme) === false);
  });
});
