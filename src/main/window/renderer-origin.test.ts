/**
 * isOwnRendererPage 的判定表。真实环境值（ELECTRON_RENDERER_URL、out/renderer）由
 * index.ts 装配，这里只测纯逻辑：dev 同源、打包 file:// 目录内放行，其余全拒。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { isOwnRendererPage } from "./renderer-origin.ts";

const DEV = { devServerUrl: "http://127.0.0.1:5273", rendererDir: "/app/out/renderer" };
const PACKED = { devServerUrl: undefined, rendererDir: "/app/out/renderer", path: posix };

test("dev：同源放行（含子路径与 HMR 全量刷新），异源拒绝", () => {
  assert.equal(isOwnRendererPage("http://127.0.0.1:5273/", DEV), true);
  assert.equal(isOwnRendererPage("http://127.0.0.1:5273/browser-toolbar.html", DEV), true);
  assert.equal(isOwnRendererPage("http://127.0.0.1:5273/src/main.tsx?t=1760000000000", DEV), true);
  assert.equal(isOwnRendererPage("http://localhost:5273/", DEV), false, "主机名不同即异源");
  assert.equal(isOwnRendererPage("http://evil.com/", DEV), false);
  assert.equal(isOwnRendererPage("file:///app/out/renderer/index.html", DEV), false, "dev 下不认 file://");
});

// POSIX 形态的 file URL 只在 POSIX 宿主上能过 fileURLToPath（Windows 上抛
// ERR_INVALID_FILE_URL_PATH，见 win32 用例的负例）；Windows 的覆盖在下面 win32 用例
test("打包：renderer 目录内的 file:// 放行，目录外与非 file 拒绝", { skip: process.platform === "win32" }, () => {
  assert.equal(isOwnRendererPage("file:///app/out/renderer/index.html", PACKED), true);
  assert.equal(isOwnRendererPage("file:///app/out/renderer/browser-toolbar.html", PACKED), true);
  assert.equal(isOwnRendererPage("file:///app/out/renderer/assets/x.js", PACKED), true);
  assert.equal(isOwnRendererPage("file:///app/out/renderer2/index.html", PACKED), false, "前缀相同的不同目录不算在内");
  assert.equal(isOwnRendererPage("file:///app/out/main/index.js", PACKED), false);
  assert.equal(isOwnRendererPage("file:///Users/x/secret.html", PACKED), false);
  assert.equal(isOwnRendererPage("http://evil.com/", PACKED), false);
});

test("解析不了的 URL 一律拒绝", () => {
  assert.equal(isOwnRendererPage("", PACKED), false);
  assert.equal(isOwnRendererPage("not a url", PACKED), false);
});

test("dev server 地址本身非法时不放行任何页面", () => {
  assert.equal(isOwnRendererPage("http://127.0.0.1:5273/", { ...DEV, devServerUrl: "::bad::" }), false);
});

test("win32：file:///C:/… 折算后落在 renderer 目录内放行", { skip: process.platform !== "win32" }, () => {
  const deps = { ...PACKED, rendererDir: "C:\\app\\out\\renderer", path: win32 };
  assert.equal(isOwnRendererPage("file:///C:/app/out/renderer/index.html", deps), true);
  assert.equal(isOwnRendererPage("file:///C:/app/out/main/index.js", deps), false);
});
