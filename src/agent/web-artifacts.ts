/**
 * 轮内网页产物旁路 —— 文件账（file-tracker.ts）只看得见 write / edit，脚本
 * （bash 里跑 node / python 等）生成的 .html / .htm / .svg 是盲区。本模块用
 * 「轮尾扫一遍，收 mtime ≥ 开轮时刻（留 2 秒余量）的网页文件」把它接回来：
 *
 *   开轮   只记 `startedAt = Date.now()`，不扫盘。
 *   轮尾   扫一遍扫描根，收 `mtimeMs >= startedAt - WEB_ARTIFACT_MTIME_SLACK_MS`
 *          的网页文件，扣掉文件账里已有的路径（write 写过的 html 两边都看得见，
 *          只该记一次），剩下的就是「本轮经脚本产出 / 改动」的旁路产物。
 *
 * 为什么不用「开轮快照 + 轮尾 diff」（上一版，因两处误报被换掉）：
 *   1. 批量文件操作（git checkout / worktree、解压归档）会一口气造出大量新
 *      mtime 的文件，diff 把它们全算成「本轮生成」；
 *   2. 大目录让两遍扫描都撞条目上限，BFS 截断点随新目录出现而漂移，第一遍没
 *      到达的旧文件在第二遍里出现，被当成「新增」——误报与漏报同时发生。
 *   按 mtime 判定后，截断只意味着「可能漏报」，不会凭空造出「本轮生成」。
 *
 * 这些产物**不参与撤销**（没拍内容快照，撤不回去），只供轮尾卡片展示与
 * 「在内置浏览器打开」。
 *
 * 扫描范围与开轮目录清单（TurnDirectories）同源：cwd + attached + 会话工作台，
 * 但**预算按根分账**：cwd 与工作台是 agent 自己的地盘，各吃全预算；附加目录
 * 可能是 `/Users/x/Documents/repo` 这种巨目录，只值小预算，撞了自己截断，
 * 不吃掉 cwd / 工作台的额度。跳过 node_modules / .git / dist / out / build /
 * .next；限深度、限访问条目数，超限就地截断（truncated = true，调用方记日志）
 * ——轮尾扫描不能明显拖慢收尾。
 *
 * 纯注入设计：读盘经 ScanFs 注入，node --test 喂假目录树。
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TurnDirectories } from "../shared/agent-ipc.ts";
import { isWebArtifactFile } from "../shared/files.ts";

/**
 * mtime 判定的时钟余量（毫秒）。开轮时刻由 agent 进程的 `Date.now()` 记，文件
 * mtime 由文件系统盖——两边各有精度与偏移，卡着相等会把「本轮前 1 秒落盘的
 * 文件」漏掉，留 2 秒换取少量多收（多收的还有批量折叠兜底）。
 */
export const WEB_ARTIFACT_MTIME_SLACK_MS = 2000;

/**
 * 一轮里逐个列出的网页文件上限。超过就判定为批量操作（git checkout / 解压
 * 归档之类）：一个不列，折叠成一行计数——把几百个 lucide svg 逐个挂上卡片
 * 既没法看，也在替用户没有做过的事背书（「你生成了 N 个网页」）。
 */
export const WEB_ARTIFACT_BATCH_LIMIT = 10;

/** 不进扫描的目录名：依赖与构建产物，量最大、又不会有「本轮的网页产物」。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next"]);

/** 根之下最多下探几层目录。orbita 仓 src/renderer/src/features/chat 是 4 层，8 层留足余量。 */
export const SCAN_MAX_DEPTH = 8;

/**
 * cwd 与会话工作台各自的条目预算（文件 + 目录）。agent 自己的地盘，扫全量；
 * 两个根各吃一份，互不侵占——附加目录再大也不该吃掉它们。
 */
export const SCAN_MAX_ENTRIES = 20000;

/**
 * 每个附加目录的条目预算。附加目录按「用户挂进来的大盘」处理：里面通常还有
 * 别的仓 / 别的 worktree（一次 `git worktree add` 就能塞进几千个文件），扫全量
 * 的代价每轮白付两遍；3 千条够覆盖「agent 真在附加目录里干活」的常见深度，
 * 撞了就地截断并记日志——宁可漏报，不可拖慢收尾、更不可误报。
 */
export const SCAN_ATTACHED_MAX_ENTRIES = 3000;

/**
 * 一个扫描根：目录 + 它自己的条目预算。预算按根分账，见文件头。
 * `webScanRoots` 负责把 cwd / 工作台 / 附加目录分进正确的档位。
 */
export interface ScanRoot {
  root: string;
  maxEntries: number;
}

/** 一轮扫描的产物。truncated = 某个根撞了它自己的条目上限（结果偏少，不是出错）。 */
export interface WebScanResult {
  /** mtime 判为本轮新出现的网页文件绝对路径（按路径排序，显示稳定） */
  paths: string[];
  truncated: boolean;
}

/** 注入的读盘面：readDir 列目录（抛错 = 目录不在 / 读不了，scan 自己兜）；statFile 给网页文件取 mtime（毫秒）。 */
export interface ScanFs {
  readDir(dir: string): Promise<readonly { name: string; isDir: boolean }[]>;
  statFile(path: string): Promise<number | null>;
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
      return info.mtimeMs;
    } catch {
      return null;
    }
  },
};

/**
 * 扫一遍 roots：收 mtime ≥ sinceMs 的网页文件。任何单点读盘失败只丢那一个
 * 目录 / 文件，不让整轮扫描失败。**每个根只花自己的预算**：一个附加目录撞上限
 * 截断，不影响其余根继续扫。重复根（同一路径出现两次）只扫一遍，按首次的预算。
 */
export async function scanWebArtifacts(
  roots: readonly ScanRoot[],
  sinceMs: number,
  fs: ScanFs = diskScanFs,
  limits: { maxDepth?: number } = {},
): Promise<WebScanResult> {
  const maxDepth = limits.maxDepth ?? SCAN_MAX_DEPTH;
  const paths = new Set<string>();
  let truncated = false;
  const scanned = new Set<string>();
  for (const { root, maxEntries } of roots) {
    if (scanned.has(root)) continue;
    scanned.add(root);
    // BFS + 游标（不用 shift：大目录树下 O(n²) 的队头搬运会白付）
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    let visited = 0;
    let rootTruncated = false;
    for (let cursor = 0; cursor < queue.length && !rootTruncated; cursor += 1) {
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
          rootTruncated = true;
          break;
        }
        if (entry.isDir) {
          if (SKIP_DIRS.has(entry.name) || depth + 1 > maxDepth) continue;
          queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
        } else if (isWebArtifactFile(entry.name)) {
          const path = join(dir, entry.name);
          const mtimeMs = await fs.statFile(path);
          if (mtimeMs !== null && mtimeMs >= sinceMs) paths.add(path);
        }
      }
    }
    if (rootTruncated) truncated = true;
  }
  return { paths: [...paths].sort(), truncated };
}

/**
 * 轮尾结算的批量折叠：命中数超过 WEB_ARTIFACT_BATCH_LIMIT 就不逐个列，改报
 * 计数（卡片出一行「本轮有 N 个网页文件变动」）。返回形状即 fileTurn 事件的
 * 两个可选字段——折叠时只给 webArtifactsBatch、不给 webArtifacts。
 */
export function foldWebArtifacts(
  paths: readonly string[],
): { webArtifacts: string[]; webArtifactsBatch?: number } {
  if (paths.length > WEB_ARTIFACT_BATCH_LIMIT) {
    return { webArtifacts: [], webArtifactsBatch: paths.length };
  }
  return { webArtifacts: [...paths] };
}

/**
 * 旁路扫描的根与预算：与开轮目录清单（describeDirectories 讲的三层地盘）同源——
 * cwd、会话工作台吃全预算，附加目录各吃小预算。去重时全预算根优先：与 cwd /
 * 工作台同路径的附加目录条目不再单开一份小预算扫描。
 */
export function webScanRoots(cwd: string, directories: TurnDirectories | undefined): ScanRoot[] {
  const full: string[] = [cwd];
  if (directories?.workbench !== undefined && directories.workbench !== "") full.push(directories.workbench);
  const seen = new Set(full);
  const roots: ScanRoot[] = full.map((root) => ({ root, maxEntries: SCAN_MAX_ENTRIES }));
  for (const root of directories?.attached ?? []) {
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push({ root, maxEntries: SCAN_ATTACHED_MAX_ENTRIES });
  }
  return roots;
}
