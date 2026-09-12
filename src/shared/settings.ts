/**
 * 应用设置契约 —— IPC 四层的第 1 层。
 *
 * 范围刻意只有主题一项。设置面从极少的 tab 起步、但 UI 第一天就落（guideline §六）；
 * 字段等有真实消费者再加，不提前占位。
 */

/**
 * 主题偏好。**四态**——"system" 是真正的默认，不是「light 的别名」：
 * 用户没表态时应用要跟着系统深浅走。system 的深色落点是 **"black"**（Ink，
 * 2026-09-03 用户指定）；"dark"（Warm）与 "black" 从此都是手动档。
 */
export const THEME_PREFERENCES = ["system", "light", "dark", "black"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface AppSettings {
  theme: ThemePreference;
  /**
   * 右侧分屏面板的宽度（4-0 拖宽）。缺席 = 默认 320；合法区间 280–560，
   * 越界或非数丢掉——这个文件用户手改得到，一个坏值不该把面板拖成一条线。
   * 拖动中不落盘，松手才写（避免写风暴）。
   */
  rightPanelWidth?: number;
}

export const DEFAULT_SETTINGS: AppSettings = { theme: "system" };

/** 右侧面板宽度的合法区间与默认值（与拖拽热区的夹取同源）。 */
export const RIGHT_PANEL_WIDTH_MIN = 280;
export const RIGHT_PANEL_WIDTH_MAX = 560;
export const RIGHT_PANEL_WIDTH_DEFAULT = 320;

function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value);
}

/**
 * 从磁盘上的任意 JSON 解出设置。
 *
 * **只认识的字段留下，别的一律丢掉**，坏值退回默认。理由是这个文件在用户目录里、
 * 手改得到：一个打错的主题名不该让应用起不来，也不该把 `theme` 变成一段任意字符串
 * 流进渲染层的 `data-theme`。
 */
export function parseSettings(raw: unknown): AppSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const theme = (raw as { theme?: unknown }).theme;
  const width = (raw as { rightPanelWidth?: unknown }).rightPanelWidth;
  return {
    theme: isThemePreference(theme) ? theme : DEFAULT_SETTINGS.theme,
    ...(typeof width === "number" &&
    Number.isFinite(width) &&
    width >= RIGHT_PANEL_WIDTH_MIN &&
    width <= RIGHT_PANEL_WIDTH_MAX
      ? { rightPanelWidth: Math.round(width) }
      : {}),
  };
}
