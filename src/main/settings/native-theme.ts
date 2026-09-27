/**
 * 我们的 UI 主题档 → Electron `nativeTheme.themeSource` 的映射。
 *
 * themeSource 只认 system / light / dark 三档（Electron 契约），直接传 black
 * 会在启动时抛错——`applyNativeTheme` 先于窗口创建跑。三个暗档（dark / graphite /
 * black）在原生层都没有对应物，**一律映射成 dark**：vibrancy 材质、原生对话框按
 * 深色走；具体明暗由 renderer 的 `data-theme` 自己画（docs/plans/2026-09-03-黑色皮肤.md
 * 决定 5）。纸面两档（copybook / typescript）同理映射成 light。
 */
import type { ThemePreference } from "../../shared/settings.ts";

export type NativeThemeSource = "system" | "light" | "dark";

export function resolveNativeThemeSource(theme: ThemePreference): NativeThemeSource {
  if (theme === "dark" || theme === "graphite" || theme === "black") return "dark";
  // 纸面两档只有明：原生层按浅色走
  if (theme === "copybook" || theme === "typescript") return "light";
  return theme;
}
