/**
 * llama-server 备取候选（llama-bin.ts）——顺序与平台后缀。纯模块直测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { llamaServerCandidates } from "./llama-bin.ts";

test("打包版：env 优先，其次 resources，dev 兜底（macOS 无后缀）", () => {
  const candidates = llamaServerCandidates({
    packaged: true,
    resourcesPath: "/Applications/orbita.app/Contents/Resources",
    appPath: "/repo",
    platform: "darwin",
    arch: "arm64",
    env: undefined,
  });
  assert.deepEqual(candidates, [
    { path: "/Applications/orbita.app/Contents/Resources/bin/llama/llama-server", source: "packaged" },
    { path: "/repo/build/bin/darwin-arm64/llama/llama-server", source: "dev" },
  ]);
});

test("环境变量排在最前；Windows 加 .exe 后缀", () => {
  const candidates = llamaServerCandidates({
    packaged: true,
    resourcesPath: "C:\\resources",
    appPath: "C:\\repo",
    platform: "win32",
    arch: "x64",
    env: "D:\\llama\\llama-server.exe",
  });
  assert.deepEqual(candidates[0], { path: "D:\\llama\\llama-server.exe", source: "env" });
  assert.equal(candidates[1]?.source, "packaged");
  assert.ok(candidates[1]?.path.endsWith("llama-server.exe"));
  assert.ok(candidates[2]?.path.includes("win32-x64"));
});

test("开发模式（packaged=false）没有 packaged 候选", () => {
  const candidates = llamaServerCandidates({
    packaged: false,
    resourcesPath: "/irrelevant",
    appPath: "/repo",
    platform: "darwin",
    arch: "arm64",
    env: undefined,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.source, "dev");
});
