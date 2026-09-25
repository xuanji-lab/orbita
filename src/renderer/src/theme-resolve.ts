import type { ThemePreference } from "@shared/settings";

/**
 * 主题偏好 → 实际要画的 `data-theme`。**纯函数**，`useTheme.ts`（运行中切主题）与
 * `main.tsx`（冷启动首帧、createRoot 之前同步写属性）共用同一份映射——两处各写一遍
 * 三元表达式正是「首帧闪系统色」bug 的根源之一：只要两处算出来的值有一帧不一致，
 * `useTheme` 的首次 apply 就会判定「变了」而套上交叉淡入。
 *
 * `system` 的深色落点是 **black**（Ink，2026-09-03 用户指定），浅色落 `light`；
 * 其余各档（light / dark / black / manuscript / typescript）原样透传——稿纸两档只有明，
 * 与系统深浅无关。
 */
export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): Exclude<ThemePreference, "system"> {
  if (preference === "system") return prefersDark ? "black" : "light";
  return preference;
}
