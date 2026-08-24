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
    server: { fs: { allow: [resolve(__dirname)] } },
    plugins: [react()],
  },
});
