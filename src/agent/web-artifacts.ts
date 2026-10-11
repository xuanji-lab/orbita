/**
 * 轮内网页产物旁路 —— 文件账（file-tracker.ts）只看得见 write / edit，脚本
 * （bash 里跑 node / python 等）生成的 .html / .htm / .svg 是盲区。本模块用
 * 「开轮拍 mtime 快照 → 轮尾再扫一遍 → diff」把它接回来：
 *
 *   开轮   scanWebArtifacts(roots) → Map<path, {mtimeMs, size}>。调用方不
 *          await——与 pi 开机并行，模型吐第一个字之前快照已拍完，轮内脚本
 *          生成的文件只会落进轮尾那一遍。
 *   轮尾   再扫一遍，diffWebArtifacts 算「新出现的 / mtime 或 size 变了的」。
 *
 * 这些产物**不参与撤销**（没拍内容快照，撤不回去），只供轮尾卡片展示与
 * 「在内置浏览器打开」。已在文件账里的路径由调用方扣掉——write 写过的 html
 * 两边都看得见，只该记一次。
 *
 * 扫描范围与开轮目录清单（TurnDirectories）同源：cwd + attached + 会话工作台。
 * 跳过 node_modules / .git / dist / out / build / .next；限深度、限访问条目数，
 * 超限就地截断（truncated = true，调用方记日志）——轮尾扫描不能明显拖慢收尾。
 *
 * 纯注入设计：读盘经 ScanFs 注入，node --test 喂假目录树。
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TurnDirectories } from "../shared/agent-ipc.ts";
import { isWebArtifactFile } from "../shared/files.ts";

/** 一个网页文件的指纹：mtime + size。两者都没动才算没变。 */
export interface WebFileStamp {
  mtimeMs: number;
  size: number;
}

/** 一轮扫描的产物。truncated = 撞条目上限被截断（结果偏少，不是出错）。 */
export interface WebScanResult {
  stamps: Map<string, WebFileStamp>;
  truncated: boolean;
}

/** 注入的读盘面：readDir 列目录（抛错 = 目录不在 / 读不了，scan 自己兜）；statFile 给网页文件取指纹。 */
export interface ScanFs {
  readDir(dir: string): Promise<readonly { name: string; isDir: boolean }[]>;
  statFile(path: string): Promise<WebFileStamp | null>;
}

/** node 的真实读盘。readdir withFileTypes 下符号链接不是 directory——天然不跟链（防环，也不绕过跳过表）。 */
export const diskScanFs: ScanFs = {
  readDir: (dir) =>
    readdir(dir, { withFileTypes: true }).then((entries) =>
      entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() })),
    ),
  statFile: async (path) => {
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return null;
    }
  },
};

/** 不进扫描的目录名：依赖与构建产物，量最大、又不会有「本轮的网页产物」。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next"]);

/** 根之下最多下探几层目录。orbita 仓 src/renderer/src/features/chat 是 4 层，8 层留足余量。 */
export const SCAN_MAX_DEPTH = 8;

/** 一次扫描最多访问的条目数（文件 + 目录）。超过就地截断并如实报告。 */
export const SCAN_MAX_ENTRIES = 20000;

/** 扫一遍 roots：收集全部网页文件的指纹。任何单点读盘失败只丢那一个目录 / 文件，不让整轮扫描失败。 */
export async function scanWebArtifacts(
  roots: readonly string[],
  fs: ScanFs = diskScanFs,
  limits: { maxDepth?: number; maxEntries?: number } = {},
): Promise<WebScanResult> {
  const maxDepth = limits.maxDepth ?? SCAN_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? SCAN_MAX_ENTRIES;
  const stamps = new Map<string, WebFileStamp>();
  let visited = 0;
  let truncated = false;
  // BFS + 游标（不用 shift：大目录树下 O(n²) 的队头搬运会白付）
  const queue: { dir: string; depth: number }[] = [...new Set(roots)].map((dir) => ({
    dir,
    depth: 0,
  }));
  for (let cursor = 0; cursor < queue.length && !truncated; cursor += 1) {
    const item = queue[cursor];
    if (item === undefined) continue;
    const { dir, depth } = item;
    let entries: readonly { name: string; isDir: boolean }[];
    try {
      entries = await fs.readDir(dir);
    } catch {
      continue; // 根不在（工作台还没建）/ 读不了（权限）：这一支交白卷，不算错
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        break;
      }
      if (entry.isDir) {
        if (SKIP_DIRS.has(entry.name) || depth + 1 > maxDepth) continue;
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      } else if (isWebArtifactFile(entry.name)) {
        const stamp = await fs.statFile(join(dir, entry.name));
        if (stamp !== null) stamps.set(join(dir, entry.name), stamp);
      }
    }
  }
  return { stamps, truncated };
}

/** 两遍快照的 diff：after 侧新出现的、或 mtime / size 变了的路径（按路径排序，显示稳定）。 */
export function diffWebArtifacts(
  before: ReadonlyMap<string, WebFileStamp>,
  after: ReadonlyMap<string, WebFileStamp>,
): string[] {
  const changed: string[] = [];
  for (const [path, stamp] of after) {
    const was = before.get(path);
    if (was === undefined || was.mtimeMs !== stamp.mtimeMs || was.size !== stamp.size) changed.push(path);
  }
  return changed.sort();
}

/** 旁路扫描的根：与开轮目录清单（describeDirectories 讲的三层地盘）同源——cwd、attached、会话工作台。 */
export function webScanRoots(cwd: string, directories: TurnDirectories | undefined): string[] {
  const roots = [cwd, ...(directories?.attached ?? [])];
  if (directories?.workbench !== undefined && directories.workbench !== "") roots.push(directories.workbench);
  return [...new Set(roots)];
}
