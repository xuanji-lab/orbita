import type { OrbitaApi } from "../../preload/index.ts";
import { createPreviewApi } from "./preview/fixture-api.ts";
import { isPreviewPath, parsePreviewOptions } from "./preview/scenes.ts";

declare global {
  interface Window {
    orbita?: OrbitaApi;
  }
}

const BRIDGE_MISSING =
  "The preload bridge is missing — window.orbita was not injected. Restart the app.";

/**
 * 桥不在时的替身。**不让整棵树崩掉**：外壳照常渲染，每次调用各自把错误报到界面上。
 *
 * 两个理由都是真的：
 *  1. preload 加载失败在 Electron 里是真实故障模式，而它今天的表现是**白屏**——比错误难查十倍；
 *  2. 渲染层要能在普通浏览器里打开做视觉验收，外壳 / 布局 / 玻璃 / 字体 / 主题都不经过 IPC。
 *
 * 订阅类方法（`onEvent`、浏览器工具条的 `onState` / `onFocusAddress`，统一 `on` + 大写字母开头）
 * 是这套 API 里唯一同步返回值的一类（返回退订函数），单独给一个空退订。
 */
function bridgeless(): OrbitaApi {
  const domain = new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string" && /^on[A-Z]/.test(key)
          ? () => () => undefined
          : () => Promise.reject(new Error(BRIDGE_MISSING)),
    },
  );
  // platform / initialTheme / initialLanguage 是标量而不是一个域，替身也得如实返回标量
  // （不能落进 domain 代理——那会把它们当成一堆待 reject 的方法拿去调用）
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "platform") return "";
        if (key === "initialTheme" || key === "initialLanguage") return null;
        return domain;
      },
    },
  ) as OrbitaApi;
}

/** renderer 侧统一入口：所有 IPC 走这里，组件不直接摸 window（旧仓 15 个文件各自直取过）。 */
const previewOptions = isPreviewPath(window.location.pathname)
  ? parsePreviewOptions(window.location.search)
  : null;
const previewApi = previewOptions === null
  ? null
  : createPreviewApi(previewOptions, window.orbita?.platform ?? "darwin");
if (previewOptions !== null) {
  // 自动化只认场景 id，不靠页面文案推断当前 fixture。
  document.documentElement.dataset["previewScene"] = previewOptions.scene;
  // 纯浏览器没有 preload，补上同名全局便于检查；Electron 里 App 仍只走下面的 previewApi，
  // 不触碰 contextBridge 的真实 IPC，也不尝试覆盖宿主全局。
  if (window.orbita === undefined && previewApi !== null) window.orbita = previewApi;
}
export const api: OrbitaApi = previewApi ?? window.orbita ?? bridgeless();
