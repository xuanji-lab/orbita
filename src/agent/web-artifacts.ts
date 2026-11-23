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
 * 但 mtime 只说明「这时间点有人写过」，不说明是谁写的。扫描根（cwd）是跨会话共享的：同一个工作区里
 * 两条会话同时在跑时，别的会话 write / edit 出来的网页 mtime 也落在本轮窗口里，被算成「这一轮生成的」
 * （2026-11-22 实测：会话 A 第 2 轮结尾多出会话 B 在 15:28:13 edit 的 demo/index.html）。所以再收两道：
 *   1. **时间窗**：只有本轮自己跑 shell / 终端 / 外接工具（ToolWindows 记的执行窗口）时才可能旁路生成网页，
 *      mtime 必须落在这些窗口里（前后各留余量）——模型想事情、别的会话写文件的空档不算。没跑过这类工具的轮不扫盘。
 *   2. **别人写的扣掉**：同一个 agent 进程里别的会话走 write / edit 写过的路径（NoteOtherWrites 的跨会话登记，
 *      文件账放行时登），本轮窗口内的不算本轮的。别的会话在 bash 里生成的看不见，窗口是它的兜底。
 *
 * 这些产物**不参与撤销**（没拍内容快照，撤不回去），只供轮尾卡片展示与
 * 「在内置浏览器打开」。
 *
 * 扫描范围只有 cwd 与会话工作台，**不扫附加目录**（2026-10-12 用户实测）：
 * 附加目录是跨会话共享的大盘（如 `/Users/x/Documents/repo`），同一时段别的会话 /
 * 子会话在里面 `git worktree add`、跑脚本，新文件的 mtime 落在本轮窗口里，mtime
 * 判定分不出「是不是这一轮生成的」——误报不可避免；而 agent 真在附加目录里生成
 * 网页的情况少见，漏报代价小。预算按根分账：cwd 与工作台各吃一份。跳过 node_modules / .git / dist / out / build /
 * .next；限深度、限访问条目数，超限就地截断（truncated = true，调用方记日志）
 * ——轮尾扫描不能明显拖慢收尾。
 *
 * 纯注入设计：读盘经 ScanFs 注入，node --test 喂假目录树。
 */
import { open, readdir, stat } from "node:fs/promises";
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
 * 一个扫描根：目录 + 它自己的条目预算。预算按根分账，见文件头。
 * `webScanRoots` 给出 cwd 与工作台两个根。
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
  limits: { maxDepth?: number; accept?: (path: string, mtimeMs: number) => boolean } = {},
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
          if (mtimeMs !== null && mtimeMs >= sinceMs && (limits.accept === undefined || limits.accept(path, mtimeMs))) {
            paths.add(path);
          }
        }
      }
    }
    if (rootTruncated) truncated = true;
  }
  return { paths: [...paths].sort(), truncated };
}

/**
 * 本轮可能在文件账之外生成网页的工具：shell、可见终端里敲命令、外接工具（它们能带着脚本跑）。
 * write / edit 走文件账，读类工具不写盘——不进窗口，轮里只有它们时轮尾根本不扫盘。
 * 可见终端里长驻的命令（dev server 之类）只算「敲下去」那一刻，之后它自己写的文件漏报，不误报。
 */
export function isScriptTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "powershell" || toolName === "terminal_execute" || toolName.startsWith("mcp__");
}

/**
 * 下载类命令：curl / wget / Invoke-WebRequest 把别人的网页存成 .html，git clone 拉下整仓。它们落盘的网页是「搬来的原料」，
 * 不是本轮做出来的东西（2026-11-23 会话 2defbe：调研时 curl 了五个官网页面去 grep，轮尾卡片把它们算成「5 个网页」）。
 * 这类命令不开窗口。代价：同一条命令里既下载又用脚本生成网页时，生成的那份漏报——宁可漏报，不替用户没做过的事背书。
 */
const DOWNLOAD_COMMAND = /\b(?:curl|wget|Invoke-WebRequest|iwr)\b|\bgit\s+clone\b|\bgh\s+repo\s+clone\b/i;

export function isDownloadCommand(args: unknown): boolean {
  if (typeof args !== "object" || args === null || !("command" in args)) return false;
  const command = args.command;
  return typeof command === "string" && DOWNLOAD_COMMAND.test(command);
}

/** 一个工具执行窗口：开跑 → 落定（毫秒时间戳）。 */
export interface ToolWindow {
  start: number;
  end: number;
}

/** 轮里各个脚本类工具的执行窗口（runtime 在 tool_execution_start / end 里喂）。 */
export class ToolWindows {
  private readonly open = new Map<string, number>();
  private readonly closed: ToolWindow[] = [];

  begin(toolCallId: string, toolName: string, at: number, args?: unknown): void {
    if (isScriptTool(toolName) && !isDownloadCommand(args)) this.open.set(toolCallId, at);
  }

  finish(toolCallId: string, at: number): void {
    const start = this.open.get(toolCallId);
    if (start === undefined) return;
    this.open.delete(toolCallId);
    this.closed.push({ start, end: Math.max(start, at) });
  }

  /** 轮尾取窗口：还没落定的（被中断）按 now 封口。 */
  snapshot(now: number): ToolWindow[] {
    return [...this.closed, ...[...this.open.values()].map((start) => ({ start, end: Math.max(start, now) }))];
  }
}

/**
 * 别的会话在本进程里 write / edit 过的路径（文件账放行时登，进程内跨会话共享）：
 * 扫描时据此把「mtime 落在本轮窗口里、但其实是别的会话写的」扣掉。只留一小时，登记表不无限涨。
 */
const OTHER_WRITES_KEEP_MS = 60 * 60 * 1000;
const otherWrites = new Map<string, { sessionId: string; at: number }[]>();

export function noteSessionWrite(sessionId: string, path: string, at: number = Date.now()): void {
  const list = otherWrites.get(path) ?? [];
  list.push({ sessionId, at });
  otherWrites.set(path, list.filter((entry) => at - entry.at <= OTHER_WRITES_KEEP_MS));
  if (otherWrites.size > 5000) {
    for (const [key, entries] of otherWrites) {
      if (entries.every((entry) => at - entry.at > OTHER_WRITES_KEEP_MS)) otherWrites.delete(key);
    }
  }
}

/** 这条路径在 sinceMs 之后被**别的**会话写过吗（写过的一律不算这条会话的旁路产物）。 */
export function writtenByOtherSession(sessionId: string, path: string, sinceMs: number): boolean {
  return (otherWrites.get(path) ?? []).some((entry) => entry.sessionId !== sessionId && entry.at >= sinceMs);
}

/** 测试用：清登记表。 */
export function resetOtherWrites(): void {
  otherWrites.clear();
}

/**
 * 旁路扫描的接收条件：mtime 落在本轮某个脚本类工具的执行窗口里（前后各留 slack），
 * 且不是别的会话在本窗口内 write / edit 的。没有窗口 = 本轮没跑过这类工具 = 不可能有旁路产物（调用方可直接跳过扫盘）。
 */
export function makeWebAccept(
  sessionId: string,
  windows: readonly ToolWindow[],
  startedAt: number,
): (path: string, mtimeMs: number) => boolean {
  return (path, mtimeMs) => {
    const inWindow = windows.some(
      (window) => mtimeMs >= window.start - WEB_ARTIFACT_MTIME_SLACK_MS && mtimeMs <= window.end + WEB_ARTIFACT_MTIME_SLACK_MS,
    );
    if (!inWindow) return false;
    return !writtenByOtherSession(sessionId, path, startedAt - WEB_ARTIFACT_MTIME_SLACK_MS);
  };
}

/**
 * 从网上存下来的页面：头部带指向 http(s) 的 canonical / og:url，或浏览器「另存为」留下的 `saved from url` 注释。
 * 下载命令那道拦不住的（node / python 脚本里 fetch 再写盘、playwright 的 page.content()）靠这道兜。
 * 只看文件头 64 KB：这些标记都在 <head> 里，实测五个官网页面最晚出现在第 18 KB。
 * 代价：agent 给用户做的、写了真实域名 canonical 的站点页会被漏报（少见）。
 */
const SAVED_PAGE_MARKERS = [
  /<link\b(?=[^>]*\bcanonical\b)(?=[^>]*https?:\/\/)[^>]*>/i,
  /<meta\b(?=[^>]*\bog:url\b)(?=[^>]*https?:\/\/)[^>]*>/i,
  /<!--\s*saved from url=/i,
];
export const SAVED_PAGE_HEAD_BYTES = 64 * 1024;

export function looksSavedFromWeb(head: string): boolean {
  return SAVED_PAGE_MARKERS.some((marker) => marker.test(head));
}

/** 读文件头（失败 = 空串，按不是存下来的页面处理）。 */
export async function readFileHead(path: string, bytes: number = SAVED_PAGE_HEAD_BYTES): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/**
 * 扣掉从网上存下来的 .html / .htm（svg 不查）。命中数远超批量上限时不逐个读——反正要折叠成计数，读了白读。
 */
export async function dropSavedPages(
  paths: readonly string[],
  readHead: (path: string) => Promise<string> = readFileHead,
): Promise<string[]> {
  if (paths.length > WEB_ARTIFACT_BATCH_LIMIT * 5) return [...paths];
  const kept: string[] = [];
  for (const path of paths) {
    if (/\.html?$/i.test(path) && looksSavedFromWeb(await readHead(path))) continue;
    kept.push(path);
  }
  return kept;
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
 * 旁路扫描的根与预算：cwd 与会话工作台，各吃全预算。**附加目录不在内**——理由见文件头。
 */
export function webScanRoots(cwd: string, directories: TurnDirectories | undefined): ScanRoot[] {
  const roots = [cwd];
  const workbench = directories?.workbench;
  if (workbench !== undefined && workbench !== "" && workbench !== cwd) roots.push(workbench);
  return roots.map((root) => ({ root, maxEntries: SCAN_MAX_ENTRIES }));
}
