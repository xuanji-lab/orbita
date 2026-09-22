import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { rowStatusIcon } from "./row-status.ts";

const none = { running: false, failed: false, done: false, pinned: false };

describe("rowStatusIcon", () => {
  it("运行中转圈，颜色是 accent", () => {
    deepStrictEqual(rowStatusIcon({ ...none, running: true }), {
      icon: "loader-circle",
      tone: "var(--color-accent)",
      label: "Running",
      spin: true,
    });
  });

  it("失败画警告三角，颜色是 danger", () => {
    strictEqual(rowStatusIcon({ ...none, failed: true })?.icon, "triangle-alert");
    strictEqual(rowStatusIcon({ ...none, failed: true })?.tone, "var(--color-danger)");
  });

  it("完成画 accent 勾", () => {
    deepStrictEqual(rowStatusIcon({ ...none, done: true }), {
      icon: "check",
      tone: "var(--color-accent)",
      label: "Done",
      spin: false,
    });
  });

  it("置顶画 pin", () => {
    strictEqual(rowStatusIcon({ ...none, pinned: true })?.icon, "pin");
  });

  it("什么都不是时槽留空——idle 不画灰勾", () => {
    strictEqual(rowStatusIcon(none), null);
  });

  it("又完成又置顶取完成：终局比排序偏好更该被看见", () => {
    strictEqual(rowStatusIcon({ ...none, done: true, pinned: true })?.icon, "check");
  });

  it("正在跑压过完成与置顶：正在发生的事优先", () => {
    strictEqual(
      rowStatusIcon({ running: true, failed: false, done: true, pinned: true })?.icon,
      "loader-circle",
    );
  });

  it("失败压过完成：跑挂了比历史标记更该被看见", () => {
    strictEqual(rowStatusIcon({ ...none, failed: true, done: true })?.icon, "triangle-alert");
  });
});
