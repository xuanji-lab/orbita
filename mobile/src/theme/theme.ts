/**
 * 手机端的主题：颜色与尺寸全部来自 `tokens.gen.ts`（由 design-system/tokens/*.css 生成），这里只做
 * 两件 CSS 做不到、RN 又必须要的换算，和手机特有的几个局部值。
 *
 * - 主题：跟随系统深浅色。浅色 = 设计系统的 light；深色 = 玄（`black`，桌面上 system 的深色落点也是它）。
 * - 字重：设计系统的 450 / 650 是可变字体的中间档，安卓系统字体（Roboto / Noto Sans CJK）只有整百档，
 *   就近落到 400 / 600（同桌面「正文比控件轻一档」的关系不变）。
 * - 行高：token 是倍数，RN 要像素，按字号乘出来。
 * - 手机特有的值（设计稿里也是挂在 `.m-device` 上的局部变量，不进 tokens/）：触控目标 44。
 */
import { useColorScheme } from "react-native";
import { COLORS, METRICS } from "./tokens.gen.ts";

export type ThemeName = "light" | "black";
export type Palette = (typeof COLORS)["light"];

export interface Theme {
  name: ThemeName;
  dark: boolean;
  color: { [K in keyof Palette]: string };
}

export function themeOf(name: ThemeName): Theme {
  return { name, dark: name !== "light", color: COLORS[name] };
}

export function useTheme(): Theme {
  return themeOf(useColorScheme() === "dark" ? "black" : "light");
}

export const space = {
  s0_5: METRICS.space0_5,
  s1: METRICS.space1,
  s1_5: METRICS.space1_5,
  s2: METRICS.space2,
  s2_5: METRICS.space2_5,
  s3: METRICS.space3,
  s4: METRICS.space4,
  s5: METRICS.space5,
  s6: METRICS.space6,
  s8: METRICS.space8,
} as const;

export const radius = {
  sm: METRICS.radiusSm,
  md: METRICS.radiusMd,
  lg: METRICS.radiusLg,
  xl: METRICS.radiusXl,
  bubble: METRICS.radiusBubble,
  pill: METRICS.radiusPill,
} as const;

export const control = {
  xs: METRICS.controlHeightXs,
  sm: METRICS.controlHeightSm,
  md: METRICS.controlHeightMd,
  lg: METRICS.controlHeightLg,
} as const;

/** 触控目标的最小边长（手指，不是鼠标；桌面的 24 / 28 / 32 台阶在手机上都太小） */
export const TOUCH = 44;

export const fontSize = {
  xl: METRICS.fontSizeXl,
  lg: METRICS.fontSizeLg,
  base: METRICS.fontSizeBase,
  sm: METRICS.fontSizeSm,
  xs: METRICS.fontSizeXs,
} as const;

type Weight = "400" | "500" | "600" | "700";

/** 可变字体的中间档落到系统字体的整百档 */
function weightOf(value: number): Weight {
  const rounded = Math.floor(value / 100) * 100;
  return String(Math.min(700, Math.max(400, rounded))) as Weight;
}

export const weight = {
  regular: weightOf(METRICS.weightRegular),
  medium: weightOf(METRICS.weightMedium),
  semibold: weightOf(METRICS.weightSemibold),
  strong: weightOf(METRICS.weightStrong),
  bold: weightOf(METRICS.weightBold),
} as const;

export function lineHeight(size: number, kind: "tight" | "ui" | "reading" = "ui"): number {
  const factor = kind === "tight" ? METRICS.lineHeightTight : kind === "reading" ? METRICS.lineHeightReading : METRICS.lineHeightUi;
  return Math.round(size * factor);
}

/** 等宽（机器事实：时间、计数、路径）：安卓系统的等宽字体 */
export const MONO = "monospace";
