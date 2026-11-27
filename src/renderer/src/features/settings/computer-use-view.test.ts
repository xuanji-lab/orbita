import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ComputerUseProbeResult, ComputerUseScreenshotResult, SandboxState } from "../../../../shared/computer-use.ts";
import {
  COMPUTER_USE_BROWSER_CHOICES,
  COMPUTER_USE_DEFAULT_ALLOW_NETWORK,
  COMPUTER_USE_DEFAULT_BROWSER,
} from "../../../../shared/computer-use.ts";
import type { AppSettings } from "../../../../shared/settings.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import {
  allowNetworkEnabled,
  allowNetworkPatch,
  allowNetworkRow,
  browserChoice,
  browserLabel,
  browserPatch,
  computerUsePage,
  probeBlocksStart,
  probeVisual,
  sandboxControl,
  shotFromResult,
  shotMeta,
  statusVisual,
} from "./computer-use-view.ts";

/** probe 结果的默认就绪形态；单测按需推翻个别字段 */
function probeResult(overrides: Partial<ComputerUseProbeResult> = {}): ComputerUseProbeResult {
  return {
    platformOk: true,
    edition: "pro",
    editionOk: true,
    featureState: "enabled",
    sandboxExeFound: true,
    hypervisorState: "present",
    isolationTier: "l2",
    isolationSession: { available: false, reason: null, nodeVersion: "24.21.0", nodeOk: true },
    wsl2: "available",
    ready: true,
    guidance: null,
    ...overrides,
  };
}

function screenshotResult(overrides: Partial<Extract<ComputerUseScreenshotResult, { ok: true }>> = {}): ComputerUseScreenshotResult {
  return {
    ok: true,
    jpegBase64: "amVwZw==",
    width: 1120,
    height: 700,
    nativeWidth: 2240,
    nativeHeight: 1400,
    takenAt: 1_760_000_000_000,
    ...overrides,
  };
}

describe("电脑使用 · 五态 → 按钮启停", () => {
  // 期望值就是主进程 SandboxController 的真实语义（src/main/computer-use/sandbox.ts）：
  // start 只在 off / error 有意义；stop 幂等，starting / running / error 都可点
  const CASES: readonly [SandboxState, { start: boolean; stop: boolean; shot: boolean }][] = [
    ["off", { start: true, stop: false, shot: false }],
    ["starting", { start: false, stop: true, shot: false }],
    ["running", { start: false, stop: true, shot: true }],
    ["stopping", { start: false, stop: false, shot: false }],
    ["error", { start: true, stop: true, shot: false }],
  ];

  for (const [state, want] of CASES) {
    test(`${state}：start=${want.start} stop=${want.stop} 截图=${want.shot}`, () => {
      const control = sandboxControl(state, null);
      assert.equal(control.canStart, want.start);
      assert.equal(control.canStop, want.stop);
      assert.equal(control.canScreenshot, want.shot);
    });
  }

  test("在途动作只压自己那颗按钮：starting 的 60 秒窗口里 stop 必须保持可点（取消启动）", () => {
    assert.equal(sandboxControl("starting", "start").canStop, true);
    assert.equal(sandboxControl("starting", "start").canStart, false);
    assert.equal(sandboxControl("running", "stop").canStop, false);
    // 截图不参与启停的在途压制：running 时始终可点
    assert.equal(sandboxControl("running", "stop").canScreenshot, true);
  });

  test("error 是可恢复态：start（重试）与 stop（复位）同时可用", () => {
    const control = sandboxControl("error", null);
    assert.equal(control.canStart, true);
    assert.equal(control.canStop, true);
  });
});

describe("电脑使用 · 五态 → 图标与文字", () => {
  test("label 两张文案表都取（en 与 zh 对齐）", () => {
    assert.deepEqual(
      (["off", "starting", "running", "stopping", "error"] as const).map((state) => statusVisual(state, en).label),
      ["Off", "Starting…", "Running", "Stopping…", "Error"],
    );
    assert.deepEqual(
      (["off", "starting", "running", "stopping", "error"] as const).map((state) => statusVisual(state, zh).label),
      ["未启动", "启动中…", "运行中", "关闭中…", "出错"],
    );
  });

  test("转场态转圈，静态态不转；running 是 success 绿，error 是 danger 红，颜色一律走 CSS 变量", () => {
    assert.equal(statusVisual("starting", en).spin, true);
    assert.equal(statusVisual("stopping", en).spin, true);
    assert.equal(statusVisual("off", en).spin, false);
    assert.equal(statusVisual("running", en).spin, false);
    assert.equal(statusVisual("error", en).spin, false);

    assert.equal(statusVisual("running", en).icon, "circle-check");
    assert.match(statusVisual("running", en).tone, /^var\(--color-success\)$/);
    assert.equal(statusVisual("error", en).icon, "triangle-alert");
    assert.match(statusVisual("error", en).tone, /^var\(--color-danger\)$/);
    for (const state of ["off", "starting", "running", "stopping", "error"] as const) {
      assert.match(statusVisual(state, zh).tone, /^var\(/, `${state} 的 tone 必须是 CSS 变量（不写裸色）`);
    }
  });
});

describe("电脑使用 · 探测结果", () => {
  test("平台不对 → 拦住「启动」（主进程 start() 同样会拒）；没探测过 / 平台对 → 不拦", () => {
    assert.equal(probeBlocksStart(null), false, "没探测过不拦，别把首屏就置灰当默认");
    assert.equal(probeBlocksStart(probeResult()), false);
    assert.equal(
      probeBlocksStart(probeResult({ platformOk: false, ready: false, guidance: "电脑使用沙箱目前只在 Windows 上可用。" })),
      true,
    );
  });
  test("就绪：ready，无指引", () => {
    assert.deepEqual(probeVisual(probeResult()), { kind: "ready" });
  });

  test("未就绪：guidance 按行拆开，空行丢弃", () => {
    const visual = probeVisual(
      probeResult({ ready: false, featureState: "disabled", guidance: "第一行\n\n  第二行  \n第三行" }),
    );
    assert.deepEqual(visual, { kind: "not-ready", guidance: ["第一行", "第二行", "第三行"] });
  });

  test("未就绪而没有 guidance（理论外）：不给出空指引", () => {
    const visual = probeVisual(probeResult({ ready: false, guidance: null }));
    assert.deepEqual(visual, { kind: "not-ready", guidance: [] });
  });
});

describe("电脑使用 · 截图回执两分支", () => {
  test("成功：带 data URL 与元信息（原始桌面尺寸、拍摄时刻）", () => {
    const shot = shotFromResult(screenshotResult());
    assert.equal(shot.kind, "ok");
    assert.ok(shot.kind === "ok");
    assert.equal(shot.src, "data:image/jpeg;base64,amVwZw==");
    assert.equal(shot.width, 2240);
    assert.equal(shot.height, 1400);
    assert.equal(shot.takenAt, 1_760_000_000_000);
  });

  test("失败：只留主进程给的原因原话，不产图", () => {
    const shot = shotFromResult({ ok: false, error: "沙箱没有在运行，先启动沙箱再截图" });
    assert.deepEqual(shot, { kind: "failed", message: "沙箱没有在运行，先启动沙箱再截图" });
  });

  test("元信息一行：原始尺寸 + 拍摄时间，两张文案表同一格式（mono 由组件样式管）", () => {
    for (const table of [en, zh] as const) {
      const meta = shotMeta(2240, 1400, 1_760_000_000_000, table);
      assert.match(meta, /^2240 × 1400 · /);
    }
  });
});

describe("电脑使用 · 出网开关", () => {
  /** AppSettings 的最小形状：parseSettings 的产物里 theme 与 drawer 恒在 */
  const settings = (allowNetwork?: boolean): AppSettings =>
    allowNetwork === undefined ? { theme: "system", drawer: { width: 320, docked: [] } } : {
      theme: "system",
      drawer: { width: 320, docked: [] },
      computerUse: { allowNetwork },
    };

  test("缺席 = 允许（与主进程 effectiveAllowNetwork 同方向，新用户不会看到 Off 而沙箱在联网）", () => {
    assert.equal(allowNetworkEnabled(settings()), true);
    assert.equal(allowNetworkEnabled(settings()), COMPUTER_USE_DEFAULT_ALLOW_NETWORK);
  });

  test("显式两个值都按盘上的来", () => {
    assert.equal(allowNetworkEnabled(settings(true)), true);
    assert.equal(allowNetworkEnabled(settings(false)), false);
  });

  test("点开关发的补丁是整块 computerUse（settings.set 走的就是这个形状）", () => {
    assert.deepEqual(allowNetworkPatch(false), { computerUse: { allowNetwork: false } });
    assert.deepEqual(allowNetworkPatch(true), { computerUse: { allowNetwork: true } });
  });

  test("info 写清「不能上网」（hover 里的完整解释）", () => {
    assert.match(zh.computerUse.allowNetworkInfo, /不能上网/);
    assert.match(zh.computerUse.allowNetworkInfo, /网页自动化需要开着/);
    assert.match(en.computerUse.allowNetworkInfo, /off the network/i);
    assert.match(en.computerUse.allowNetworkInfo, /web automation needs it on/i);
    assert.ok(en.computerUse.allowNetwork.length > 0 && zh.computerUse.allowNetwork.length > 0);
  });

  test("生效时机常驻在 below 里，且点明运行中的沙箱不改（不只在 hover）", () => {
    // 运行中点了「关」而沙箱还在联网是这一行最大的误读风险：那句必须看得见
    for (const table of [en, zh] as const) {
      assert.ok(table.computerUse.allowNetworkBelow.length > 0, "below 不能是空句");
    }
    assert.match(zh.computerUse.allowNetworkBelow, /下次启动/);
    assert.match(zh.computerUse.allowNetworkBelow, /仍按启动时/);
    assert.match(en.computerUse.allowNetworkBelow, /next time the sandbox starts/i);
    assert.match(en.computerUse.allowNetworkBelow, /running sandbox/i);
  });
});

/**
 * 出网那一行在三个后端上的可操作性（allowNetworkRow）。
 *
 * 这条是「设置骗人」的界面侧：L2b 断不了网，所以那一行不可操作 + 行底给原因；
 * wsb / qemu 照常。判定与提示词读同一个谓词（shared 的 backendNetworkControl），
 * 这里再钉一遍是因为「组件自己写 if」很容易在下一刀里分叉。
 */
describe("电脑使用 · 出网开关在三个后端上能不能动", () => {
  test("wsb / qemu：可操作（它们真能把出网关掉）", () => {
    assert.deepEqual(allowNetworkRow("wsb", zh), { editable: true });
    assert.deepEqual(allowNetworkRow("qemu", zh), { editable: true });
  });

  test("isolation-session：不可操作，且给出一行原因（不是静默置灰）", () => {
    const row = allowNetworkRow("isolation-session", zh);
    assert.equal(row.editable, false);
    if (row.editable) assert.fail("L2b 上这一行必须是不可操作的");
    assert.ok(row.reason.length > 0, "置灰必须说清为什么");
    assert.match(row.reason, /断不了网/);
    assert.equal(row.reason, zh.computerUse.allowNetworkLocked);
  });

  test("英文口径同义（同一句原因，不各写一套）", () => {
    const row = allowNetworkRow("isolation-session", en);
    if (row.editable) assert.fail("L2b 上这一行必须是不可操作的");
    assert.equal(row.reason, en.computerUse.allowNetworkLocked);
    assert.match(row.reason, /cannot block the network/);
    assert.doesNotMatch(row.reason, /no outbound network/i);
  });
});

describe("电脑使用 · 沙箱浏览器", () => {
  const settings = (browser?: "edge" | "chrome" | "brave" | "chromium" | "auto"): AppSettings =>
    browser === undefined
      ? { theme: "system", drawer: { width: 320, docked: [] } }
      : { theme: "system", drawer: { width: 320, docked: [] }, computerUse: { browser } };

  test("缺席 = edge（UI 自己兜缺省，与 effectiveGuestBrowser 同源）", () => {
    assert.equal(browserChoice(settings()), "edge");
    assert.equal(browserChoice(settings()), COMPUTER_USE_DEFAULT_BROWSER);
    assert.equal(browserChoice(settings("edge")), "edge");
  });

  test("盘上写过的值原样显示（五个选项一个不漏）", () => {
    for (const choice of COMPUTER_USE_BROWSER_CHOICES) {
      assert.equal(browserChoice(settings(choice)), choice);
    }
  });

  test("点选项发的补丁只带 browser（不冲掉 allowNetwork / allowedApps）", () => {
    assert.deepEqual(browserPatch("chrome"), { computerUse: { browser: "chrome" } });
    assert.deepEqual(browserPatch("edge"), { computerUse: { browser: "edge" } });
  });

  test("芯片文字：专有名词不翻译，只有 auto 走 i18n", () => {
    assert.equal(browserLabel("edge", zh.computerUse.browserAuto), "Edge");
    assert.equal(browserLabel("chrome", zh.computerUse.browserAuto), "Chrome");
    assert.equal(browserLabel("brave", zh.computerUse.browserAuto), "Brave");
    assert.equal(browserLabel("chromium", zh.computerUse.browserAuto), "Chromium");
    assert.equal(browserLabel("auto", zh.computerUse.browserAuto), zh.computerUse.browserAuto);
    assert.equal(browserLabel("auto", en.computerUse.browserAuto), en.computerUse.browserAuto);
    assert.equal(zh.computerUse.browserAuto, "自动");
    assert.equal(en.computerUse.browserAuto, "Auto");
  });

  test("chips 顺序 = COMPUTER_USE_BROWSER_CHOICES（Edge 在最左 = 默认）", () => {
    assert.deepEqual([...COMPUTER_USE_BROWSER_CHOICES], ["edge", "chrome", "brave", "chromium", "auto"]);
  });

  test("hint 说实话：Chrome / Brave 要先放进沙箱，否则回退 Edge", () => {
    for (const table of [en, zh] as const) {
      assert.ok(table.computerUse.browser.length > 0);
      assert.ok(table.computerUse.browserInfo.length > 0);
      assert.ok(table.computerUse.browserBelow.length > 0, "below 不能是空句");
    }
    assert.match(zh.computerUse.browserBelow, /映射或拷贝/);
    assert.match(zh.computerUse.browserBelow, /回退 Edge/);
    assert.match(zh.computerUse.browserInfo, /默认 Edge/);
    assert.match(en.computerUse.browserBelow, /map or copy/i);
    assert.match(en.computerUse.browserBelow, /falls back to Edge/i);
    assert.match(en.computerUse.browserInfo, /Edge is the default/i);
  });
});

describe("电脑使用 · 平台闸门（这一页画控件还是警示卡）", () => {
  test("Windows：照旧画整套控件", () => {
    assert.deepEqual(computerUsePage("win32"), { kind: "controls" });
  });

  test("平台值不明（preload 桥没就绪：空串 / 缺字段）：既不给控件也不给卡——此刻 IPC 全挂，报「平台不支持」是错误归因", () => {
    for (const platform of ["", "   ", null, undefined]) {
      const page = computerUsePage(platform);
      assert.equal(page.kind, "unknown", String(platform));
      assert.notEqual(page.kind, "unsupported");
      assert.notEqual(page.kind, "controls");
    }
  });

  test("非 Windows：整页换成警示卡，reasonKey 指向对应那一句（macOS / Linux / 其它）", () => {
    const mac = computerUsePage("darwin");
    assert.equal(mac.kind, "unsupported");
    assert.deepEqual(mac.kind === "unsupported" ? mac.support : null, {
      supported: false,
      kind: "macos",
      reasonKey: "macos",
    });
    assert.equal(computerUsePage("linux").kind === "unsupported", true);
    assert.equal(computerUsePage("freebsd").kind, "unsupported");
  });

  test("警示卡每一条 reasonKey 在中英两张表里都有正文（平台枚举与文案不会各长各的）", () => {
    for (const platform of ["darwin", "linux", "freebsd"]) {
      const page = computerUsePage(platform);
      assert.equal(page.kind, "unsupported");
      if (page.kind !== "unsupported" || page.support.reasonKey === null) continue;
      const key = page.support.reasonKey;
      for (const table of [zh, en]) {
        assert.ok(table.computerUse.platformUnsupported.body[key].length > 0, `${platform} → ${key}`);
      }
    }
    // 标题与「要什么环境」两行两张表都有
    for (const table of [zh, en]) {
      assert.ok(table.computerUse.platformUnsupported.title.length > 0);
      assert.ok(table.computerUse.platformUnsupported.requirement.length > 0);
    }
  });
});
