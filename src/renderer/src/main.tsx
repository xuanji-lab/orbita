import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api.ts";
import { resolveTheme } from "@shared/theme-resolve";
import { htmlLang } from "./locale.ts";
import { effectiveLanguage } from "@shared/settings";
import { watchWindowActivity } from "./shell/window-activity.ts";
import "./styles.css";
import "./paper-themes.css";

// 窗口不在前台（失焦 / 标签页隐藏）时暂停持续动效（styles.css 的
// `[data-window-inactive="true"]` 规则）——见 window-activity.ts 的理由。
watchWindowActivity();

// 文件落在输入框以外的地方：Chromium 默认把窗口导航到那个 file://——整个应用被换成
// 一张图，草稿与排队全丢。输入框自己的 drop 在冒泡到这里之前已经处理完；这里只拦默认行为。
// 只认带文件的拖拽：队列行的拖拽排序不受影响。
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    if (event.dataTransfer?.types.includes("Files") === true) event.preventDefault();
  });
}

/*
 * 冷启动第一帧：主进程已经把用户选的主题塞进 --orbita-theme=（preload 的
 * api.initialTheme），这里在 createRoot 之前直接把 data-theme 写对——
 * useTheme.ts 首次 apply 时 current === resolved，不套一层
 * View Transitions 交叉淡入。api.initialTheme === null（桥缺失 / 非 Electron
 * 环境）时什么都不做，退回旧路径：首帧按 App 的初始 state 起步，读到真设置后
 * useTheme 才第一次落 data-theme。
 */
if (api.initialTheme !== null) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(api.initialTheme, prefersDark);
  document.documentElement.dataset["theme"] = resolved;
  // 语言跟主题走（locale.ts）：lang 与 data-theme 同一帧写对，首帧中文不按英文字形排
  document.documentElement.lang = htmlLang(effectiveLanguage(resolved, api.initialLanguage ?? undefined));
}

const container = document.getElementById("root");
if (!container) throw new Error("root container missing in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
