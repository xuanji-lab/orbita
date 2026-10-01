import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { effectiveLanguage, type Language, type ThemePreference } from "@shared/settings";
import { resolveTheme } from "./theme-resolve.ts";
import { htmlLang } from "./locale.ts";

/**
 * 主题落地。**设置优先、系统兜底**——设计系统的 token 只认 `data-theme`
 * （tokens/colors.css 没有 prefers-color-scheme 分支），所以这件事由渲染层显式做。
 *
 * `system` 的深色落点是 **black**（玄 Onyx，2026-09-03 用户指定、2026-09-30 换血后沿用）；
 * graphite（黛 Slate）与 black（玄 Onyx）都是手动档。只有 `system` 才订阅系统深浅变化：
 * 用户明确选了之后，系统换了色也不该把他的选择顶掉。
 *
 * 切换本身包一层 View Transitions 整窗交叉淡入——直接换属性，深→浅是瞬跳、
 * 浅→深会闪一帧（2026-09-04 用户实测）。首帧应用不加动画；系统开了
 * 「减少动态效果」时也不加。
 *
 * 返回解析后的主题：界面语言由它与语言设置一起派生（shared 的 `effectiveLanguage`）。`<html lang>` 与
 * `data-theme` 在同一处、同一次提交里写——文案表的切换也包进同一次交叉淡入
 * （transition 回调里 flushSync），换到小学作业时颜色和中文一起淡入，
 * 不是先换色、淡入完了文字再跳一下。
 */
export function useTheme(
  preference: ThemePreference,
  language: Language | undefined,
): Exclude<ThemePreference, "system"> {
  const [resolvedTheme, setResolvedTheme] = useState(() =>
    resolveTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      const resolved = resolveTheme(preference, query.matches);
      const root = document.documentElement;
      const current = root.dataset["theme"];
      const commit = () => {
        root.dataset["theme"] = resolved;
        root.lang = htmlLang(effectiveLanguage(resolved, language));
      };
      if (current === resolved) {
        commit();
        setResolvedTheme(resolved);
        return;
      }
      const doc = document as Document & {
        startViewTransition?: (update: () => void) => void;
      };
      if (current !== undefined && !reduceMotion.matches && doc.startViewTransition) {
        doc.startViewTransition(() => {
          // 回调在快照之后异步执行，不在 effect 里——flushSync 让新文案与新颜色进同一帧
          flushSync(() => setResolvedTheme(resolved));
          commit();
        });
      } else {
        commit();
        setResolvedTheme(resolved);
      }
    };
    apply();
    if (preference !== "system") return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference, language]);
  return resolvedTheme;
}
