/**
 * 我们的 UI 主题档 → Electron `nativeTheme.themeSource` 的映射。
 *
 * themeSource 只认 system / light / dark 三档（Electron 契约），直接传 black
 * 会在启动时抛错——`applyNativeTheme` 先于窗口创建跑。black 在原生层没有对应物，
 * **映射成 dark**：vibrancy 材质、原生对话框按深色走；纯黑的部分由 renderer 的
 * `data-theme="black"` 自己画（docs/plans/2026-09-03-黑色皮肤.md 决定 5）。
 */
import type { ThemePreference } from "../../shared/settings.ts";

export type NativeThemeSource = "system" | "light" | "dark";

export function resolveNativeThemeSource(theme: ThemePreference): NativeThemeSource {
  return theme === "black" ? "dark" : theme;
}
