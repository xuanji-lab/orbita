/**
 * 更新卡上字节数与进度的格式化（update-format.ts）。
 * 钉住两件事：MB / KB 的分档与小数位，以及总量缺席时不说「6.2 / 0 KB」。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, progressAmount, progressPercent } from "./update-format.ts";

describe("formatBytes —— 字节数", () => {
  test("MB 档一位小数（安装包就是这一档）", () => {
    assert.equal(formatBytes(14.8 * 1024 * 1024), "14.8 MB");
    assert.equal(formatBytes(209_839_723), "200.1 MB");
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  });

  test("1MB 以下退到 KB，0 与坏值就是 0 KB", () => {
    assert.equal(formatBytes(620 * 1024), "620 KB");
    assert.equal(formatBytes(1), "1 KB");
    assert.equal(formatBytes(0), "0 KB");
    assert.equal(formatBytes(Number.NaN), "0 KB");
    assert.equal(formatBytes(-5), "0 KB");
  });
});

describe("progressAmount —— 下载中的两个数", () => {
  test("两个数都在时写成 a / b", () => {
    assert.equal(progressAmount(6.2 * 1024 * 1024, 14.8 * 1024 * 1024), "6.2 MB / 14.8 MB");
  });

  test("总量缺席只报已下载（不写成 / 0 KB）", () => {
    assert.equal(progressAmount(6.2 * 1024 * 1024, 0), "6.2 MB");
    assert.equal(progressAmount(0, Number.NaN), "0 KB");
  });
});

describe("progressPercent —— 进度条宽度", () => {
  test("钳在 0–100", () => {
    assert.equal(progressPercent(42.5), 42.5);
    assert.equal(progressPercent(120), 100);
    assert.equal(progressPercent(-3), 0);
    assert.equal(progressPercent(Number.NaN), 0);
  });
});
