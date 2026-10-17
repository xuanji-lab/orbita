import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ComputerUseProbeResult, ComputerUseScreenshotResult, SandboxState } from "../../../../shared/computer-use.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import {
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
    ready: true,
    guidance: null,
    ...overrides,
  };
}

function screenshotResult(overrides: Partial<Extract<ComputerUseScreenshotResult, { ok: true }>> = {}): ComputerUseScreenshotResult {
  return {
    ok: true,
    jpegBase64: "amVwZw==",
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
