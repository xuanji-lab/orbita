import { useEffect } from "react";
import type { ThemePreference } from "@shared/settings";
import { resolveTheme } from "./theme-resolve.ts";

/**
 * 主题落地。**设置优先、系统兜底**——设计系统的 token 只认 `data-theme`
 * （tokens/colors.css 没有 prefers-color-scheme 分支），所以这件事由渲染层显式做。
 *
 * `system` 的深色落点是 **black**（Ink，2026-09-03 用户指定）；dark（Warm）与
 * black（Ink）从此都是手动档。只有 `system` 才订阅系统深浅变化：用户明确选了
 * 之后，系统换了色也不该把他的选择顶掉。
 *
 * 切换本身包一层 View Transitions 整窗交叉淡入——直接换属性，深→浅是瞬跳、
 * 浅→深会闪一帧（2026-09-04 用户实测）。首帧应用不加动画；系统开了
 * 「减少动态效果」时也不加。
 */
export function useTheme(preference: ThemePreference): void {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      const resolved = resolveTheme(preference, query.matches);
      const root = document.documentElement;
      const current = root.dataset["theme"];
      if (current === resolved) return;
      const doc = document as Document & {
        startViewTransition?: (update: () => void) => void;
      };
      if (current !== undefined && !reduceMotion.matches && doc.startViewTransition) {
        doc.startViewTransition(() => {
          root.dataset["theme"] = resolved;
        });
      } else {
        root.dataset["theme"] = resolved;
      }
    };
    apply();
    if (preference !== "system") return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference]);
}
