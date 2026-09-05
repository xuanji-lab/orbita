/**
 * 应用设置契约 —— IPC 四层的第 1 层。
 *
 * 范围刻意只有主题一项。设置面从极少的 tab 起步、但 UI 第一天就落（guideline §六）；
 * 字段等有真实消费者再加，不提前占位。
 */

/**
 * 主题偏好。**四态**——"system" 是真正的默认，不是「light 的别名」：
 * 用户没表态时应用要跟着系统深浅走，而不是把某一档钉死。
 * "black" 是**手动档**：系统只有深浅两态，跟随系统永远落到 light/dark，
 * black 只能用户亲手选（docs/plans/2026-09-03-黑色皮肤.md 决定 2）。
 */
export const THEME_PREFERENCES = ["system", "light", "dark", "black"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface AppSettings {
  theme: ThemePreference;
}

export const DEFAULT_SETTINGS: AppSettings = { theme: "system" };

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
  return { theme: isThemePreference(theme) ? theme : DEFAULT_SETTINGS.theme };
}
