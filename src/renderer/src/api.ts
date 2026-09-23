import type { OrbitaApi } from "../../preload/index.ts";

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
 * `onEvent` 是这套 API 里唯一同步返回值的方法（返回退订函数），单独给一个空退订。
 */
function bridgeless(): OrbitaApi {
  const domain = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "onEvent"
          ? () => () => undefined
          : () => Promise.reject(new Error(BRIDGE_MISSING)),
    },
  );
  // platform / initialTheme 是标量而不是一个域，替身也得如实返回标量
  // （不能落进 domain 代理——那会把它们当成一堆待 reject 的方法拿去调用）
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "platform") return "";
        if (key === "initialTheme") return null;
        return domain;
      },
    },
  ) as OrbitaApi;
}

/** renderer 侧统一入口：所有 IPC 走这里，组件不直接摸 window（旧仓 15 个文件各自直取过）。 */
export const api: OrbitaApi = window.orbita ?? bridgeless();
