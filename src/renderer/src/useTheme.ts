import { useEffect } from "react";
import type { ThemePreference } from "@shared/settings";

/**
 * 主题落地。**设置优先、系统兜底**——设计系统的 token 只认 `data-theme`
 * （tokens/colors.css 没有 prefers-color-scheme 分支），所以这件事由渲染层显式做。
 *
 * 只有 `system` 这一档才订阅系统深浅变化：用户明确选了 light/dark 之后，
 * 系统换了色也不该把他的选择顶掉。black 是手动档原样透传——系统只有深浅两态，
 * 跟随系统永远落不到 black（docs/plans/2026-09-03-黑色皮肤.md 决定 2）。
 */
export function useTheme(preference: ThemePreference): void {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        preference === "system" ? (query.matches ? "dark" : "light") : preference;
      document.documentElement.dataset["theme"] = resolved;
    };
    apply();
    if (preference !== "system") return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference]);
}
