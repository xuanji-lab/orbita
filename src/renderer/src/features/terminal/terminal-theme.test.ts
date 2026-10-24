import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

describe("终端滚动条复用全局细条口径（xterm 6 画自己的 DOM 滚动条，不吃 *::-webkit-scrollbar）", () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
  test("宽 = 全局 8px：经 overviewRuler.width 喂给 xterm（缺省 14px 太粗）", () => {
    const view = read("./TerminalView.tsx");
    const global = read("../../styles.css");
    const width = /const TERMINAL_SCROLLBAR_WIDTH = (\d+);/.exec(view)?.[1];
    const globalWidth = /\*::-webkit-scrollbar \{\s*width:\s*(\d+)px/.exec(global)?.[1];
    assert.ok(width !== undefined && globalWidth !== undefined);
    assert.equal(width, globalWidth, "终端滚动条宽要与全局滚动条同宽");
    assert.match(view, /overviewRuler: \{ width: TERMINAL_SCROLLBAR_WIDTH \}/);
  });
  test("滑块颜色同全局 thumb token，滑块圆角是胶囊", () => {
    const theme = read("./terminal-theme.ts");
    assert.match(theme, /scrollbarSliderBackground = thumb/);
    assert.match(theme, /getPropertyValue\("--color-border-default"\)/);
    assert.match(theme, /scrollbarSliderHoverBackground = thumbStrong/);
    const css = read("./terminal.css");
    assert.match(css, /\.scrollbar > \.slider \{\s*border-radius:\s*var\(--radius-pill\)/);
    assert.match(theme, /overviewRulerBorder = "rgba\(0, 0, 0, 0\)"/, "借 overviewRuler 定宽会附带一条标尺边线，必须透明");
  });
});
