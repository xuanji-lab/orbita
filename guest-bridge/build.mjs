// build.mjs —— 定位 Windows 自带的 .NET Framework 4.x csc.exe 并编译 guest bridge。
// 零依赖 node 脚本；产物为几十 KB 的独立 exe（沙箱里不能装任何运行时，这是刻意为之）。
// 用法：node build.mjs（在任意工作目录运行都可以，路径基于脚本位置解析）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(scriptDir, "bin");
const outFile = path.join(outDir, "orbita-guest-bridge.exe");

function findCsc() {
  const winDir = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  // 兜底：扫 Framework64\v4.0.*，版本号大的优先（v4.0.30319 之外的 4.x 编译目录）
  const framework64 = path.join(winDir, "Microsoft.NET", "Framework64");
  try {
    const versions = fs
      .readdirSync(framework64)
      .filter((d) => /^v4\.0\.\d+$/.test(d))
      .sort()
      .reverse();
    for (const v of versions) {
      candidates.push(path.join(framework64, v, "csc.exe"));
    }
  } catch {
    // 目录不存在则跳过兜底扫描
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const csc = findCsc();
if (!csc) {
  console.error("[build] 未找到 csc.exe（需要 Windows 自带的 .NET Framework 4.x）");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const args = [
  "/nologo",
  "/target:exe",
  "/platform:anycpu",
  "/optimize+",
  "/codepage:65001", // 源码为 UTF-8（含中文注释），显式声明避免按系统 ANSI 码页误读
  `/out:${outFile}`,
  "/r:System.dll",
  "/r:System.Core.dll",
  "/r:System.Drawing.dll",
  path.join(scriptDir, "Program.cs"),
  // CDP 浏览器通道（0.4.0）：单独一个源文件，免得 Program.cs 再涨一倍
  // （仍然零依赖、仍然只产出一个 exe）
  path.join(scriptDir, "Cdp.cs"),
  // 可杀的 CDP worker（0.7.0）：主桥路由 + worker 进程本体 + worker 层自测
  path.join(scriptDir, "WorkerHost.cs"),
  // TCP 命令通道（0.8.0）：监听 + 行协议 + 握手；文件协议是它的回退通道
  path.join(scriptDir, "TcpChannel.cs"),
  // 按窗口截图（0.9.0）：win-list / win-shot + 黑帧自检与过滤的纯函数
  path.join(scriptDir, "WinShot.cs"),
];

console.log(`[build] csc: ${csc}`);
const result = spawnSync(csc, args, { stdio: "inherit" });
if (result.error) {
  console.error(`[build] 启动 csc 失败：${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[build] 编译失败，退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log(`[build] 已生成 ${outFile}`);
