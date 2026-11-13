/**
 * llama-server 二进制的备取 —— **纯模块**（不 import electron，可被
 * `node --test` 直接测；search-bins.ts 的同款分层）。存在性检查在调用方
 * （index.ts 拿候选表依序 existsSync），这里只给路径与来源。
 *
 * 三条来路（按优先级）：
 * 1. 环境变量 ORBITA_LLAMA_SERVER 指到具体可执行文件（排障 / 自备版本）；
 * 2. 安装包：resources/bin/llama/llama-server(.exe)（scripts/fetch-llama.mjs
 *    取回、electron-builder 放进 extraResources，双平台同布局）；
 * 3. 开发模式：仓库 build/bin/<platform>-<arch>/llama/（跑一次 fetch 脚本）。
 *
 * 开发模式取用说明（README 级的操作，写在这里是因为不往仓里放 markdown）：
 * `node scripts/fetch-llama.mjs`（约 17-25MB，钉死版本与 sha256），然后
 * `bun run dev` 起的应用就能在 build/bin 下找到它；没跑过脚本 = 向量召回
 * 不可用，状态页如实显示「未找到」。
 */
import { join } from "node:path";

export interface LlamaServerCandidate {
  path: string;
  source: "env" | "packaged" | "dev";
}

export function llamaServerCandidates(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
  env?: string | undefined;
}): LlamaServerCandidate[] {
  const exe = input.platform === "win32" ? "llama-server.exe" : "llama-server";
  const candidates: LlamaServerCandidate[] = [];
  if (typeof input.env === "string" && input.env !== "") {
    candidates.push({ path: input.env, source: "env" });
  }
  if (input.packaged) {
    candidates.push({ path: join(input.resourcesPath, "bin", "llama", exe), source: "packaged" });
  }
  candidates.push({
    path: join(input.appPath, "build", "bin", `${input.platform}-${input.arch}`, "llama", exe),
    source: "dev",
  });
  return candidates;
}
