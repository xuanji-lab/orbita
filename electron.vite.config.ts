import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * pi 的图片缩放（read 工具读图、用户附图）靠 photon（Rust/WASM）。photon-node 的加载写法是
 * `readFileSync(path.join(__dirname, "photon_rs_bg.wasm"))`——被打进 `out/main/chunks/` 之后
 * __dirname 指向 chunk 所在目录，而 wasm 不会被 rollup 带过来。结果：photon 加载失败、
 * `resizeImage` 恒返 null，**连一张尺寸达标的小图也读不了**（它要先解码才知道尺寸）。
 *
 * 这里把 wasm 作为资源发到「含 photon 的那个 chunk」旁边。不写死 chunks/ 目录：按
 * chunk 实际包含的模块找，分块策略变了也跟得上。**找不到就让构建失败**——这次的病就是
 * 静默坏掉的；哪天 pi 不再用 photon，让构建当场说出来，再删这个插件。
 *
 * worker 那条路（`image-resize-worker.js`）同样因打包而找不到文件，pi 会退回进程内缩放——
 * 缩放跑在 agent utility 进程，不占主进程，不值得为它再拷一份 worker 入口。
 */
function photonWasmNextToChunk(): Plugin {
  const marker = "/@silvia-odwyer/photon-node/";
  return {
    name: "orbita:photon-wasm",
    generateBundle(_options, bundle) {
      const emitted = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const photonModule = Object.keys(output.modules).find((id) => id.replaceAll("\\", "/").includes(marker));
        if (photonModule === undefined) continue;
        const fileName = posix.join(posix.dirname(output.fileName), "photon_rs_bg.wasm");
        if (emitted.has(fileName)) continue;
        emitted.add(fileName);
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(resolve(dirname(photonModule.replace(/^\0/, "").split("?")[0] ?? ""), "photon_rs_bg.wasm")),
        });
      }
      if (emitted.size === 0) this.error("没有找到打包了 photon-node 的 chunk——pi 的图片缩放路径变了，先核对再删掉这个插件");
    },
  };
}

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
          "terminal-runtime": resolve(__dirname, "src/terminal/runtime.ts"),
        },
        /**
         * @napi-rs/canvas（read_pdf 页图渲染）保持 external：它的入口是一串平台包
         * require 回退（win32-x64-msvc / darwin-arm64 / …），被打进 bundle 后 .node
         * 二进制的解析链断裂，requireCanvas 拿到 undefined，agent 进程起不来
         * （2026-09-27 实测：`agent runtime exited with code 1`，直接跑产物崩在
         * `"families" in GlobalFonts`）。external 后 require 原样保留，从项目
         * node_modules 解析——与 photon 的 wasm 资产拷贝是两种病：wasm 是文件
         * 丢了可以拷，.node 是原生模块必须留在原地 require。正则覆盖平台子包。
         *
         * node-pty（terminal runtime 的 PTY）同理：.node 预构建 + ConPTY 的
         * conpty.dll / OpenConsole.exe 靠 __dirname 定位，打进 bundle 必断。
         * N-API 预构建跨 Electron ABI，不需要 electron-rebuild。
         */
        external: [/^@napi-rs\/canvas/, /^node-pty$/],
        output: { entryFileNames: "[name].js" },
      },
    },
    plugins: [photonWasmNextToChunk()],
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
    build: {
      rollupOptions: {
        // 两个页面入口：主窗口，与受管浏览器沙盒窗口的工具条（main/browser/sandbox.ts）
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          "browser-toolbar": resolve(__dirname, "src/renderer/browser-toolbar.html"),
        },
      },
    },
    server: {
      /**
       * **固定端口、只绑 IPv4 回环、撞了当场失败。**
       *
       * 事故（2026-08-25）：orbita 与同机的 proma 都吃 vite 默认的 5173，
       * 一次 `pkill -f "electron-vite dev"` 把两边一起打死了。
       *
       * 但真正难查的不是撞端口，是**双栈**：macOS 允许一个进程绑
       * `127.0.0.1:5173`、另一个绑 `[::1]:5173`，两个 bind 都成功，
       * 所以 `strictPort` **拦不住**。此时 `localhost` 解析到谁取决于客户端——
       * curl 走 IPv4、Chrome 常偏好 IPv6——于是同一个 URL 在两个工具里
       * 指向两个不同的应用。我的截图验收因此对着 proma 拍了整整一轮。
       *
       * 三条一起才管用：唯一端口 5273、`host` 明确绑 IPv4 回环（不再双栈监听）、
       * `strictPort` 让冲突当场失败。脚本里也一律用 `127.0.0.1:5273`，
       * 不用 `localhost`——把解析这一层的歧义整个去掉。
       */
      host: "127.0.0.1",
      port: 5273,
      strictPort: true,
      fs: { allow: [resolve(__dirname)] },
    },
    plugins: [react()],
  },
});
