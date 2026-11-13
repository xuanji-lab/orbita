import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { rowStatusIcon } from "./row-status.ts";
import { en } from "../messages-en.ts";

const none = { subRunning: false, pinned: false };

describe("rowStatusIcon", () => {
  it("子会话在跑画 git-fork，颜色与状态饼的 running 同 token（--color-info）", () => {
    deepStrictEqual(rowStatusIcon({ ...none, subRunning: true }, en), {
      icon: "git-fork",
      tone: "var(--color-info)",
      label: "Sub-session running",
    });
  });

  it("置顶画 pin", () => {
    strictEqual(rowStatusIcon({ ...none, pinned: true }, en)?.icon, "pin");
  });

  it("子会话在跑压过置顶", () => {
    strictEqual(rowStatusIcon({ ...none, subRunning: true, pinned: true }, en)?.icon, "git-fork");
  });

  it("什么都不是时槽留空——运行 / 未读 / 失败都归状态饼，行首不再画图标", () => {
    strictEqual(rowStatusIcon(none, en), null);
  });
});
