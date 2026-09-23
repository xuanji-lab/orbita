/**
 * 冷启动第一帧要用的主题偏好。**不是 IPC 通道，是个同步常量**——同 `index.ts` 里
 * `platform` 的先例：主进程建窗口时把当次读到的设置塞进 `--orbita-theme=` 命令行参数
 * （`webPreferences.additionalArguments`），这里在 preload 里原样读出来，渲染层
 * `main.tsx` 用它在 `createRoot` 之前把 `data-theme` 写对，不必等 `settings:get`
 * 那趟 IPC 跑完、再让 `useTheme` 套一层交叉淡入动画。
 */
import { THEME_PREFERENCES, type ThemePreference } from "../shared/settings.ts";

const ARG_PREFIX = "--orbita-theme=";

/**
 * 从 `argv` 里找 `--orbita-theme=` 前缀的值。**手改坏的 argv、缺参数、非法值统统回
 * `null`，不抛**——首帧退回旧路径（渲染层按 `system` 起步，读到真设置后再套动画），
 * 用户看到的最坏结果是少一次优化，不是白屏。多个同名参数只取第一个。
 */
export function readInitialTheme(argv: readonly string[]): ThemePreference | null {
  const arg = argv.find((entry) => entry.startsWith(ARG_PREFIX));
  if (arg === undefined) return null;
  const value = arg.slice(ARG_PREFIX.length);
  return (THEME_PREFERENCES as readonly string[]).includes(value) ? (value as ThemePreference) : null;
}
