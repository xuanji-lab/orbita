import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * electron-vite 三段构建：main / preload / renderer。
 * renderer 直接 @import 仓库根的「Orbita Design System」——设计系统是 UI 真源，
 * 不复制一份到 src 下，避免 token 漂移（AGENTS.md「设计系统」一节）。
 * 该目录在 renderer root 之外，故显式放行 fs 访问。
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // agent runtime 与主进程同一段构建、同一个输出目录，但是**两个进程的入口**
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "agent-runtime": resolve(__dirname, "src/agent/runtime.ts"),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
    server: {
      /**
       * **固定端口，并且撞了就报错。**
       *
       * 事故（2026-08-25）：orbita 与同机的另一个 electron-vite 应用都吃 vite 默认的 5173。
       * 一次 `pkill -f "electron-vite dev"` 同时打死了两边，5173 随后被对方占住，
       * 而 vite 的默认行为是**悄悄换一个端口**——于是我们的截图验收对着别人的应用拍了一轮
       * 才被发现。`strictPort` 让端口冲突当场失败，不给「悄悄漂走」留余地。
       *
       * 5273 是刻意挑的：离 5173 一位，读起来仍是「一个 vite dev server」，但不是默认那个。
       */
      port: 5273,
      strictPort: true,
      fs: { allow: [resolve(__dirname)] },
    },
    plugins: [react()],
  },
});
