/**
 * 浏览器空白 tab 的不透明垫底色：按**当前主题档**取设计系统的 `--color-bg-app`。
 *
 * 为什么要垫：没加载过任何页面的 WebContentsView 是透明的，而所有 tab 叠在同一块
 * 区域上——不垫底色，空白的用户 tab 会透出下面 agent tab 的页面。
 *
 * 为什么按档而不是按系统深浅：深色有黛 / 玄两档、浅色有明 / 两档纸面，各自的壳底不同；
 * 只看 nativeTheme 的深浅，空白页会和工具条、主窗口的壳对不上色。
 *
 * 主进程读不到 CSS 变量，所以这里抄一份色值；`page-background.test.ts` 逐档对照
 * tokens/colors.css 的 `--color-bg-app`，改了 token 忘了改这里会当场红。
 */
import type { ThemePreference } from "../../shared/settings.ts";
import { resolveTheme } from "../../shared/theme-resolve.ts";

export const PAGE_BACKGROUNDS: Record<Exclude<ThemePreference, "system">, string> = {
  light: "#f3f4f1",
  graphite: "#202021",
  black: "#2b2b2b",
  copybook: "#e6e4dc",
  typescript: "#e6e4dc",
};

export function pageBackgroundColor(preference: ThemePreference, prefersDark: boolean): string {
  return PAGE_BACKGROUNDS[resolveTheme(preference, prefersDark)];
}
