/**
 * 沙箱坐标换算的账（shared/computer-use.ts 的纯函数）。
 *
 * 为什么值得单独测：模型给的坐标是**它看到的那张图**的像素，而 SendInput 要的是沙箱
 * 物理屏的像素——两张图的比例只有工具层知道。换算错了不会报错，只会「点到了别的地方」，
 * 而且隔着沙箱看不出来。越界一律回 null（不做猜测性钳制）是这里的另一半：模型算错时
 * 我们要给它一句「这张图只有 1280×720」，不是替它点个它没打算点的地方。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_USE_SHOT_MAX_WIDTH,
  isWindowScreenshotRequest,
  screenshotPointToNative,
} from "./computer-use.ts";

/** 回图 1280×720，物理屏 2560×1440（长边缩一半的常见情形） */
const scaled = { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440 };

describe("screenshotPointToNative", () => {
  test("没缩放（回图 = 物理屏）：坐标原样过", () => {
    const shot = { width: 2560, height: 1440, nativeWidth: 2560, nativeHeight: 1440 };
    assert.deepEqual(screenshotPointToNative(shot, 100, 200), { x: 100, y: 200 });
    assert.deepEqual(screenshotPointToNative(shot, 0, 0), { x: 0, y: 0 });
  });

  test("长边缩一半：图像坐标乘 2 得到物理像素", () => {
    assert.deepEqual(screenshotPointToNative(scaled, 100, 200), { x: 200, y: 400 });
    assert.deepEqual(screenshotPointToNative(scaled, 0, 0), { x: 0, y: 0 });
    assert.deepEqual(screenshotPointToNative(scaled, 1279, 719), { x: 2558, y: 1438 });
  });

  test("两个轴各算各的比例（等比是桥的实现细节，不是协议）", () => {
    const shot = { width: 100, height: 100, nativeWidth: 1000, nativeHeight: 500 };
    assert.deepEqual(screenshotPointToNative(shot, 50, 50), { x: 500, y: 250 });
  });

  test("贴边写法（x == width / y == height）合法，落在最后一个像素上", () => {
    assert.deepEqual(screenshotPointToNative(scaled, 1280, 720), { x: 2559, y: 1439 });
  });

  test("图外 / 负数 / 非有限数一律 null——不钳制、不猜", () => {
    assert.equal(screenshotPointToNative(scaled, 1281, 100), null);
    assert.equal(screenshotPointToNative(scaled, 100, 721), null);
    assert.equal(screenshotPointToNative(scaled, -1, 0), null);
    assert.equal(screenshotPointToNative(scaled, 0, -1), null);
    assert.equal(screenshotPointToNative(scaled, Number.NaN, 10), null);
    assert.equal(screenshotPointToNative(scaled, 10, Number.POSITIVE_INFINITY), null);
  });

  test("四舍五入到整数像素（3 像素宽的图 → 10 像素的屏）", () => {
    const shot = { width: 3, height: 3, nativeWidth: 10, nativeHeight: 10 };
    assert.deepEqual(screenshotPointToNative(shot, 1, 1), { x: 3, y: 3 });
    assert.deepEqual(screenshotPointToNative(shot, 2, 2), { x: 7, y: 7 });
  });

  test("回图宽度上限是 1280（工具层按它压图省上下文）", () => {
    assert.equal(COMPUTER_USE_SHOT_MAX_WIDTH, 1280);
  });
});

describe("isWindowScreenshotRequest（租约分流的唯一判据）", () => {
  test("整桌面截图：false（仍要 desktop:exclusive）", () => {
    assert.equal(isWindowScreenshotRequest({ action: "screenshot" }), false);
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", maxWidth: 1280 }), false);
  });

  test("screenshot + window（标题或 hwnd）：true（不占桌面）", () => {
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", window: "Edge" }), true);
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", window: 4321, maxWidth: 640 }), true);
    // 空串也是「给了 window」：宿主要照常下发，让桥回一句「没找到这个窗口」，
    // 而不是悄悄退成整桌面截图（那会拍到用户没要的画面）
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", window: "" }), true);
  });

  test("像素输入与浏览器动作：false（各有各的租约）", () => {
    assert.equal(isWindowScreenshotRequest({ action: "click", x: 1, y: 2 }), false);
    assert.equal(isWindowScreenshotRequest({ action: "type", text: "x" }), false);
    assert.equal(isWindowScreenshotRequest({ action: "sandbox-navigate", url: "https://example.com" }), false);
  });
});
