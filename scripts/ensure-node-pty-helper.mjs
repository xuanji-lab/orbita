// node-pty 的 spawn-helper 补执行位（postinstall 调用）。
//
// bun 安装 node-pty 预构建产物时会丢掉 spawn-helper 的执行位（实测 1.1.0 落盘为 rw-rw-rw-）。
// node-pty 在 macOS / Linux 上靠这个 helper 孵化 PTY；没有执行位时只抛一句
// "posix_spawnp failed"，所有终端都起不来（人工面板与 agent 的 terminal_* 工具一起挂）。
// Windows 走 ConPTY，不用 helper，这里找不到文件就什么都不做。
// 做法同 Proma 的 scripts/ensure-node-pty-helper-executable.ts。
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "node-pty");
const candidates = [
  join(root, "build", "Release", "spawn-helper"),
  join(root, "build", "Debug", "spawn-helper"),
  join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
];

for (const helper of candidates) {
  if (!existsSync(helper)) continue;
  const mode = statSync(helper).mode;
  if ((mode & 0o111) === 0o111) continue;
  chmodSync(helper, mode | 0o755);
  console.log(`[node-pty] 已恢复 spawn-helper 执行权限：${helper}`);
}
