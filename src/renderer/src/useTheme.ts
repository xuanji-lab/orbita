import { useEffect } from "react";
import type { ThemePreference } from "@shared/settings";

/**
 * 主题落地。**设置优先、系统兜底**——设计系统的 token 只认 `data-theme`
 * （tokens/colors.css 没有 prefers-color-scheme 分支），所以这件事由渲染层显式做。
 *
 * `system` 的深色落点是 **black**（Ink，2026-09-03 用户指定）；dark（Warm）与
 * black（Ink）从此都是手动档。只有 `system` 才订阅系统深浅变化：用户明确选了
 * 之后，系统换了色也不该把他的选择顶掉。
 */
export function useTheme(preference: ThemePreference): void {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        preference === "system" ? (query.matches ? "black" : "light") : preference;
      document.documentElement.dataset["theme"] = resolved;
    };
    apply();
    if (preference !== "system") return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference]);
}
