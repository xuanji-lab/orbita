import type { OrbitaApi } from "../../preload/index.ts";

declare global {
  interface Window {
    orbita: OrbitaApi;
  }
}

/** renderer 侧统一入口：所有 IPC 走这里，组件不直接摸 window（旧仓 15 个文件各自直取过）。 */
export const api: OrbitaApi = window.orbita;
