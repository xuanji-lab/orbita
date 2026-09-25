import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RetryStatus } from "@shared/agent-ipc";
import { retryCauseText, retryLineText, retryRemainingSeconds } from "./retry-text.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

// startedAt=10_000、delayMs=4_000 → 到期时刻 14_000
const status = (over: Partial<RetryStatus> = {}): RetryStatus => ({
  attempt: 2,
  maxAttempts: 3,
  delayMs: 4000,
  startedAt: 10_000,
  errorMessage: "fetch failed",
  ...over,
});

describe("retryRemainingSeconds —— 向上取整，到期为 null", () => {
  test("期内按剩余毫秒向上取整：1ms 也算还有 1 秒", () => {
    assert.equal(retryRemainingSeconds(status(), 10_000), 4);
    assert.equal(retryRemainingSeconds(status(), 10_001), 4);
    assert.equal(retryRemainingSeconds(status(), 13_999), 1);
  });

  test("正好到期与已过期都返回 null", () => {
    assert.equal(retryRemainingSeconds(status(), 14_000), null);
    assert.equal(retryRemainingSeconds(status(), 15_000), null);
  });
});

describe("retryLineText —— Retry N/M 与倒数", () => {
  it("等待中：次数 + 秒数", () => {
    assert.equal(retryLineText(status(), 11_000, en), "Retry 2/3 · in 3s");
  });

  it("到期后不显示 0 秒——如实说正在重试（倒数到 0 与尝试开跑之间有零点几秒的缝）", () => {
    assert.equal(retryLineText(status(), 14_000, en), "Retry 2/3 · Retrying…");
  });
});

describe("retryCauseText —— 失败原因行内截断", () => {
  it("短的原样返回；空白的返回 null 不渲染", () => {
    assert.equal(retryCauseText("fetch failed"), "fetch failed");
    assert.equal(retryCauseText(""), null);
    assert.equal(retryCauseText("   "), null);
  });

  it("超长截到 80 字符加省略号（全文由组件的 title 给）", () => {
    const long = "x".repeat(100);
    assert.equal(retryCauseText(long), `${"x".repeat(80)}…`);
    assert.equal(retryCauseText("y".repeat(80)), "y".repeat(80));
  });
});

describe("retryLineText —— 中文（Manuscript）", () => {
  it("次数与倒数都说中文", () => {
    assert.equal(retryLineText(status(), 11_000, zh), "第 2/3 次重试 · 3 秒后");
    assert.equal(retryLineText(status(), 14_000, zh), "第 2/3 次重试 · 正在重试…");
  });
});
