import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api.ts";
import { resolveTheme } from "./theme-resolve.ts";
import "./styles.css";

/*
 * 冷启动第一帧：主进程已经把用户选的主题塞进 --orbita-theme=（preload 的
 * api.initialTheme），这里在 createRoot 之前直接把 data-theme 写对——
 * useTheme.ts 首次 apply 时 current === resolved，直接 return，不套一层
 * View Transitions 交叉淡入。api.initialTheme === null（桥缺失 / 非 Electron
 * 环境）时什么都不做，退回旧路径：首帧按 App 的初始 state 起步，读到真设置后
 * useTheme 才第一次落 data-theme。
 */
if (api.initialTheme !== null) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset["theme"] = resolveTheme(api.initialTheme, prefersDark);
}

const container = document.getElementById("root");
if (!container) throw new Error("root container missing in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
