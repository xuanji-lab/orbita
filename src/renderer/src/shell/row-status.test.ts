import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { rowStatusIcon } from "./row-status.ts";
import { en } from "../messages-en.ts";

const none = { running: false, failed: false, pinned: false };

describe("rowStatusIcon", () => {
  it("运行中画静态实心点，颜色是 accent，不转圈", () => {
    deepStrictEqual(rowStatusIcon({ ...none, running: true }, en), {
      icon: "circle-dot",
      tone: "var(--color-accent)",
      label: "Running",
      spin: false,
    });
  });

  it("失败画警告三角，颜色是 danger", () => {
    strictEqual(rowStatusIcon({ ...none, failed: true }, en)?.icon, "triangle-alert");
    strictEqual(rowStatusIcon({ ...none, failed: true }, en)?.tone, "var(--color-danger)");
  });

  it("置顶画 pin", () => {
    strictEqual(rowStatusIcon({ ...none, pinned: true }, en)?.icon, "pin");
  });

  it("什么都不是时槽留空——idle 不画灰勾", () => {
    strictEqual(rowStatusIcon(none, en), null);
  });

  it("正在跑压过置顶：正在发生的事优先", () => {
    strictEqual(
      rowStatusIcon({ running: true, failed: false, pinned: true }, en)?.icon,
      "circle-dot",
    );
  });

  it("失败压过置顶：跑挂了比排序偏好更该被看见", () => {
    strictEqual(rowStatusIcon({ ...none, failed: true, pinned: true }, en)?.icon, "triangle-alert");
  });
});
