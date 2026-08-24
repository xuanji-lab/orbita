import { useEffect } from "react";

/**
 * 设计系统的 token 只认 `data-theme`（tokens/colors.css 没有 prefers-color-scheme 分支），
 * 所以跟随系统深浅这件事由渲染层显式做。用户级主题设置落地后，这里改为「设置优先、系统兜底」。
 */
export function useSystemTheme(): void {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (dark: boolean) => {
      document.documentElement.dataset["theme"] = dark ? "dark" : "light";
    };
    apply(query.matches);
    query.addEventListener("change", (event) => apply(event.matches));
    return () => query.removeEventListener("change", (event) => apply(event.matches));
  }, []);
}
