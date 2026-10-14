import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseTerminalMetric } from "./terminal-theme.ts";

describe("parseTerminalMetric —— 终端字号 / 行高从 token 解成 xterm 要的数", () => {
  test("带 px 的字号与无单位行高都能解", () => {
    assert.equal(parseTerminalMetric("13px", 99), 13);
    assert.equal(parseTerminalMetric(" 1.25 ", 99), 1.25);
  });

  test("token 缺失（空串）回落到声明值，不画成 0 号字", () => {
    assert.equal(parseTerminalMetric("", 13), 13);
  });

  test("非法值与非正数都回落", () => {
    assert.equal(parseTerminalMetric("large", 13), 13);
    assert.equal(parseTerminalMetric("0px", 13), 13);
    assert.equal(parseTerminalMetric("-2px", 13), 13);
  });
});
