import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAYBACK_RATES,
  fractionAtPointer,
  formatClock,
  formatLabel,
  formatRate,
  isKnownDuration,
  localMediaPathOfHref,
  mediaKeyAction,
  nextRate,
  progressFraction,
  seekTarget,
} from "./media-view.ts";

const key = (k: string, extra: Partial<Parameters<typeof mediaKeyAction>[0]> = {}) =>
  mediaKeyAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, targetTag: "DIV", ...extra });

describe("formatClock", () => {
  test("分:秒、补零、向下取整", () => {
    assert.equal(formatClock(0), "0:00");
    assert.equal(formatClock(7), "0:07");
    assert.equal(formatClock(3.9), "0:03");
    assert.equal(formatClock(231), "3:51");
    assert.equal(formatClock(3599), "59:59");
  });
  test("满一小时才出小时位", () => {
    assert.equal(formatClock(3600), "1:00:00");
    assert.equal(formatClock(3723), "1:02:03");
  });
  test("负数 / NaN / Infinity → 0:00", () => {
    for (const v of [-5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatClock(v), "0:00");
  });
});

describe("进度换算", () => {
  test("isKnownDuration", () => {
    assert.equal(isKnownDuration(231), true);
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(isKnownDuration(v), false);
  });
  test("progressFraction 夹在 [0,1]，时长未知为 0", () => {
    assert.equal(progressFraction(50, 100), 0.5);
    assert.equal(progressFraction(150, 100), 1);
    assert.equal(progressFraction(-3, 100), 0);
    assert.equal(progressFraction(5, Number.POSITIVE_INFINITY), 0);
    assert.equal(progressFraction(5, 0), 0);
  });
  test("fractionAtPointer 夹取、条宽 0 不除零", () => {
    assert.equal(fractionAtPointer(150, 100, 200), 0.25);
    assert.equal(fractionAtPointer(50, 100, 200), 0);
    assert.equal(fractionAtPointer(900, 100, 200), 1);
    assert.equal(fractionAtPointer(150, 100, 0), 0);
  });
  test("seekTarget：±5 秒夹在 [0, duration]", () => {
    assert.equal(seekTarget(10, 5, 100), 15);
    assert.equal(seekTarget(2, -5, 100), 0);
    assert.equal(seekTarget(98, 5, 100), 100);
    assert.equal(seekTarget(98, 5, Number.POSITIVE_INFINITY), 103);
    assert.equal(seekTarget(Number.NaN, 5, 100), 5);
  });
});

describe("倍速", () => {
  test("循环 1 → 1.25 → 1.5 → 2 → 1", () => {
    assert.deepEqual(PLAYBACK_RATES, [1, 1.25, 1.5, 2]);
    assert.equal(nextRate(1), 1.25);
    assert.equal(nextRate(1.25), 1.5);
    assert.equal(nextRate(1.5), 2);
    assert.equal(nextRate(2), 1);
    assert.equal(nextRate(0.5), 1);
  });
  test("显示", () => {
    assert.equal(formatRate(1), "1×");
    assert.equal(formatRate(1.25), "1.25×");
  });
});

describe("mediaKeyAction", () => {
  test("空格 toggle，← / → 跳转", () => {
    assert.equal(key(" "), "toggle");
    assert.equal(key("ArrowLeft"), "back");
    assert.equal(key("ArrowRight"), "forward");
  });
  test("焦点在按钮上空格不重复触发，方向键照常", () => {
    assert.equal(key(" ", { targetTag: "BUTTON" }), null);
    assert.equal(key("ArrowRight", { targetTag: "BUTTON" }), "forward");
  });
  test("带修饰键、别的键不吃", () => {
    assert.equal(key("ArrowLeft", { metaKey: true }), null);
    assert.equal(key(" ", { ctrlKey: true }), null);
    assert.equal(key("ArrowRight", { shiftKey: true }), null);
    assert.equal(key("k"), null);
  });
});

describe("formatLabel", () => {
  test("扩展名大写", () => {
    assert.equal(formatLabel("wang_summary.mp3"), "MP3");
    assert.equal(formatLabel("a.b.webm"), "WEBM");
    assert.equal(formatLabel("noext"), "");
    assert.equal(formatLabel(".hidden"), "");
    assert.equal(formatLabel("trailing."), "");
  });
});

describe("localMediaPathOfHref", () => {
  test("绝对路径 / file URL / 百分号编码", () => {
    assert.equal(localMediaPathOfHref("/Users/a/audio/x.mp3"), "/Users/a/audio/x.mp3");
    assert.equal(localMediaPathOfHref("file:///Users/a/My%20Clip.MP4"), "/Users/a/My Clip.MP4");
    assert.equal(localMediaPathOfHref("/Users/a/%E7%8E%8B.mp3"), "/Users/a/王.mp3");
    assert.equal(localMediaPathOfHref("C:\\media\\a.webm"), "C:\\media\\a.webm");
    assert.equal(localMediaPathOfHref("file:///C:/media/a.mov"), "C:/media/a.mov");
  });
  test("非媒体扩展名 / 相对路径 / 网址 / 空 → null", () => {
    assert.equal(localMediaPathOfHref("/Users/a/x.txt"), null);
    assert.equal(localMediaPathOfHref("x.mp3"), null);
    assert.equal(localMediaPathOfHref("./x.mp3"), null);
    assert.equal(localMediaPathOfHref("https://example.com/x.mp3"), null);
    assert.equal(localMediaPathOfHref("javascript:alert(1)//x.mp3"), null);
    assert.equal(localMediaPathOfHref(undefined), null);
    assert.equal(localMediaPathOfHref(""), null);
  });
});
