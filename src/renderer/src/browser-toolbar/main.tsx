/**
 * 受管浏览器沙盒窗口的工具条页面入口（electron-vite 的第二个 renderer 入口，
 * 主进程见 main/browser/sandbox.ts）。
 *
 * 工具条只占窗口顶部一条（`--browser-toolbar-height`），下方是主进程贴上去的网页视图——
 * 这个页面画不到那块区域，也不需要画。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { effectiveLanguage } from "@shared/settings";
import { api } from "../api.ts";
import { htmlLang } from "../locale.ts";
import { resolveTheme } from "../theme-resolve.ts";
import { BrowserToolbar } from "./BrowserToolbar";
import "../styles.css";
import "../paper-themes.css";
import "./browser-toolbar.css";

// 首帧主题与语言：同主窗口 main.tsx，读建窗时塞进来的 --orbita-theme / --orbita-language
if (api.initialTheme !== null) {
  const resolved = resolveTheme(api.initialTheme, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset["theme"] = resolved;
  document.documentElement.lang = htmlLang(effectiveLanguage(resolved, api.initialLanguage ?? undefined));
}

const container = document.getElementById("root");
if (!container) throw new Error("root container missing in browser-toolbar.html");

createRoot(container).render(
  <StrictMode>
    <BrowserToolbar />
  </StrictMode>,
);
