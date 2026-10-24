/**
 * xterm 的调色板 —— 运行时读 CSS 变量。xterm 的 theme 只吃实色字符串，而设计
 * 纪律（AGENTS.md「禁裸 hex」）要求颜色从 token 来：值声明在 terminal.css（明/暗
 * 两套 ANSI + 画布四色），这里按主题现场解成 xterm 要的形状。主题切换由
 * TerminalView 监听 `data-theme` 重读，不缓存在模块层。
 */
import type { ITheme } from "@xterm/xterm";

const ANSI_ORDER = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

/** 逐个读 :root 上的 --terminal-* 并去掉首尾空白；缺了就交给 xterm 的出厂默认 */
export function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => style.getPropertyValue(name).trim();
  const theme: ITheme = {};
  const background = read("--terminal-bg");
  const foreground = read("--terminal-fg");
  const cursor = read("--terminal-cursor");
  const selection = read("--terminal-selection");
  if (background !== "") theme.background = background;
  if (foreground !== "") theme.foreground = foreground;
  if (cursor !== "") {
    theme.cursor = cursor;
    theme.cursorAccent = cursor;
  }
  if (selection !== "") theme.selectionBackground = selection;
  // 滚动条滑块：xterm 6 画的是自己的 DOM 滚动条（VS Code 那套），不吃全局
  // *::-webkit-scrollbar 的细条规则——颜色只能经 theme 喂。口径同全局：thumb 贴
  // --color-border-default，悬停 / 按住加深一档到 --color-border-strong
  const thumb = style.getPropertyValue("--color-border-default").trim();
  const thumbStrong = style.getPropertyValue("--color-border-strong").trim();
  if (thumb !== "") theme.scrollbarSliderBackground = thumb;
  if (thumbStrong !== "") {
    theme.scrollbarSliderHoverBackground = thumbStrong;
    theme.scrollbarSliderActiveBackground = thumbStrong;
  }
  // 定滚动条宽要借 overviewRuler.width，而开了概览标尺 xterm 会在它左缘画一条
  // overviewRulerBorder（缺省浅灰），暗色下是一根贯穿全高的亮线——我们不用标尺，
  // 边线一律透明（实测：不设时右缘多出 1px 竖线）
  theme.overviewRulerBorder = "rgba(0, 0, 0, 0)";
  const ansi = ANSI_ORDER.map((name) => read(`--terminal-ansi-${name}`));
  const brightAnsi = ANSI_ORDER.map((name) => read(`--terminal-ansi-bright-${name}`));
  if (ansi.every((value) => value !== "")) {
    theme.black = ansi[0];
    theme.red = ansi[1];
    theme.green = ansi[2];
    theme.yellow = ansi[3];
    theme.blue = ansi[4];
    theme.magenta = ansi[5];
    theme.cyan = ansi[6];
    theme.white = ansi[7];
  }
  if (brightAnsi.every((value) => value !== "")) {
    theme.brightBlack = brightAnsi[0];
    theme.brightRed = brightAnsi[1];
    theme.brightGreen = brightAnsi[2];
    theme.brightYellow = brightAnsi[3];
    theme.brightBlue = brightAnsi[4];
    theme.brightMagenta = brightAnsi[5];
    theme.brightCyan = brightAnsi[6];
    theme.brightWhite = brightAnsi[7];
  }
  return theme;
}

/**
 * 终端的字号 / 行高也从 token 来（`--font-size-terminal` / `--line-height-terminal`，
 * typography.css 的「内容例外」）：xterm 只吃数字，这里把 CSS 值解成数。
 * 解不出来（token 缺失 / 不是正数）就回落到 token 的声明值，终端不至于画成 0 号字。
 */
export function parseTerminalMetric(raw: string, fallback: number): number {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readTerminalMetrics(): { fontSize: number; lineHeight: number } {
  const style = getComputedStyle(document.documentElement);
  return {
    fontSize: parseTerminalMetric(style.getPropertyValue("--font-size-terminal"), 13),
    lineHeight: parseTerminalMetric(style.getPropertyValue("--line-height-terminal"), 1.25),
  };
}

/**
 * Windows 上 xterm.js 必须知道 ConPTY 的 build 才能选对 resize/回绕路径。固定成
 * 最早完整支持 ConPTY 的 build 19041，让所有 Windows 版本都走保守兼容路径——
 * 避免 xterm.js 与 ConPTY 对输入行/历史缓冲重复重排（光标上跳的老毛病，调研 1.4 节）。
 */
export const CONSERVATIVE_CONPTY_BUILD = 19041;
