/**
 * 审查面板的 git 只读来源 —— git CLI 的薄封装（只跑 status / diff / rev-parse，
 * 绝不写）。空态分类（没有 git / 不是仓库 / 没有 upstream）在这里判好，面板只管显示。
 *
 * 注入 runner：node --test 可以喂假 git；真实 runner 用 execFile（不带 shell，
 * 参数走数组——路径里有空格 / `--` 都不会被曲解）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, stat } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import {
  parseNumstatLine,
  parseStatusChangedLine,
  parseUntrackedLine,
  type ReviewDiff,
  type ReviewEntry,
  type ReviewList,
  type ReviewSource,
} from "../../shared/review.ts";
import type { FocusChangeEntry, FocusChanges } from "../../shared/focus.ts";

const execFileAsync = promisify(execFile);

export interface GitRunOutcome {
  code: number;
  stdout: string;
}

/** 退出码非 0 不是异常（not-repo / no-upstream 都用它表达）；ENOENT 单独抛给上层。 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunOutcome>;

export const realGitRunner: GitRunner = async (args, cwd) => {
  try {
    // -c core.quotepath=false：非 ASCII 路径原样输出。git 默认把中文路径 C 转义成
    // `"\344\270\255.txt"`——未跟踪文件读盘 ENOENT 被静默跳过、已跟踪文件拉空 diff
    // 误显「与基线一致」。加在 runner 一处，rev-parse / status / diff 全部生效。
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (cause) {
    // 非零退出码不是异常（not-repo / no-upstream 靠它表达）：stdout 在 error 上原样带回；
    // ENOENT（没有 git）重新抛，上层翻成 no-git 空态
    const failure = cause as { code?: number | string; stdout?: string; errno?: string };
    if (failure.code === "ENOENT" || failure.errno === "ENOENT") throw cause;
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "" };
  }
};

/** 仓库根：跑得动且返回路径 = 是仓库；code 128 = 不是；ENOENT = 没有 git。 */
async function repoRoot(runner: GitRunner, cwd: string): Promise<string | null> {
  const result = await runner(["rev-parse", "--show-toplevel"], cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

function numstatEntries(stdout: string): ReviewEntry[] {
  const entries: ReviewEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseNumstatLine(line);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** 未跟踪文件的读盘面（测试注入假货）：null = 读不了 / 不是文件（跳过）。 */
export type UntrackedReader = (path: string) => Promise<Buffer | null>;

const diskUntrackedReader: UntrackedReader = async (path) => {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
};

/**
 * status 的路径默认就是工作区相对（git 1.5.4 起），但工作区之外的改动会带 `../` 前缀
 * ——不归这棵树管（与 `git diff --relative` 的排除口径一致）。git 只输出 `/` 分隔。
 */
function insideWorkspace(path: string): boolean {
  return path !== ".." && !path.startsWith("../");
}

/** 未跟踪文件（porcelain v2 的 `? ` 行）：行数对着空文件算，二进制标 binary。 */
async function untrackedEntries(
  cwd: string,
  statusStdout: string,
  read: UntrackedReader = diskUntrackedReader,
): Promise<ReviewEntry[]> {
  const entries: ReviewEntry[] = [];
  for (const line of statusStdout.split("\n")) {
    const path = parseUntrackedLine(line);
    if (path === null || !insideWorkspace(path)) continue;
    const bytes = await read(`${cwd}/${path}`);
    // 刚被删 / 读不了：跳过——status 快照与磁盘现状之间的窗口，不值得报错
    if (bytes === null) continue;
    if (bytes.includes(0)) {
      entries.push({ path, added: 0, removed: 0, binary: true });
      continue;
    }
    const content = bytes.toString("utf8");
    const patch = createTwoFilesPatch("/dev/null", path, "", content);
    let added = 0;
    for (const line2 of patch.split("\n")) {
      if (line2.startsWith("+") && !line2.startsWith("+++")) added += 1;
    }
    entries.push({ path, added, removed: 0, binary: false });
  }
  return entries;
}

/** branch 源的 upstream 短名（origin/main）；拿不到返回 null。 */
async function upstreamName(runner: GitRunner, cwd: string): Promise<string | null> {
  const result = await runner(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

/**
 * 来源 → git diff 的参数组。列表带 `--numstat`（行级统计，numstatEntries 解析）；
 * 正文不带（unified diff 原样返回）。曾共用一套参数、列表忘了 --numstat，
 * 真 git 输出 patch 正文被 numstat 解析器全部丢弃——三源列表永远空。
 */
function diffArgs(
  source: ReviewSource,
  upstream: string | null,
  opts: { path?: string; numstat?: boolean } = {},
): string[] | null {
  // --no-renames：改名拆成「删旧 + 增新」两条真实路径。开着改名检测时 numstat 输出
  // `旧名.txt => 新名.txt` 一行，解析出的路径读不了盘、拉不到 diff（空正文误显「已还原」）。
  const numstat = opts.numstat === true ? ["--numstat"] : [];
  const pathArg = opts.path === undefined ? [] : ["--", opts.path];
  // --relative：在子目录里跑时把输出路径改成**工作区相对**，并排除工作区之外的改动。
  // 不加时 diff 给的是仓库根相对路径，与 status 的工作区相对路径不是同一基准——
  // 两套路径混进同一份列表，按它去 `git diff -- <path>` 就找不到（误显「已还原」）。
  if (source === "unstaged") return ["diff", "--no-renames", "--relative", ...numstat, ...pathArg];
  if (source === "staged") {
    return ["diff", "--cached", "--no-renames", "--relative", ...numstat, ...pathArg];
  }
  if (source === "branch") {
    if (upstream === null) return null;
    return ["diff", "--no-renames", "--relative", ...numstat, `${upstream}...HEAD`, ...pathArg];
  }
  return null;
}

/** `review:list` 的 git 侧实现。readUntracked 只为测试注入（未跟踪文件的读盘面）。 */
export async function gitReviewList(
  runner: GitRunner,
  cwd: string,
  source: ReviewSource,
  readUntracked: UntrackedReader = diskUntrackedReader,
): Promise<ReviewList> {
  let root: string | null;
  try {
    root = await repoRoot(runner, cwd);
  } catch {
    return { kind: "empty", reason: "no-git", cwd };
  }
  if (root === null) return { kind: "empty", reason: "not-repo", cwd };

  if (source === "branch") {
    const upstream = await upstreamName(runner, cwd);
    if (upstream === null) return { kind: "empty", reason: "no-upstream", cwd };
    const args = diffArgs(source, upstream, { numstat: true });
    if (args === null) return { kind: "empty", reason: "no-upstream", cwd };
    const entries = numstatEntries((await runner(args, cwd)).stdout);
    return entries.length === 0
      ? { kind: "empty", reason: "no-changes", cwd }
      : { kind: "ok", cwd, entries, upstream };
  }

  if (source === "unstaged") {
    const status = await runner(["status", "--porcelain=v2", "--untracked-files=all"], cwd);
    const diff = await runner(diffArgs(source, null, { numstat: true }) ?? [], cwd);
    const entries = [...numstatEntries(diff.stdout), ...(await untrackedEntries(cwd, status.stdout, readUntracked))];
    if (entries.length === 0) return { kind: "empty", reason: "no-changes", cwd };
    // 同一路径可能两处出现（已改 + 未跟踪不会同路径；稳妥起见去重保序）
    const seen = new Set<string>();
    const unique = entries.filter((entry) => (seen.has(entry.path) ? false : seen.add(entry.path)));
    return { kind: "ok", cwd, entries: unique };
  }

  const diff = await runner(diffArgs(source, null, { numstat: true }) ?? [], cwd);
  const entries = numstatEntries(diff.stdout);
  return entries.length === 0
    ? { kind: "empty", reason: "no-changes", cwd }
    : { kind: "ok", cwd, entries };
}

/** `git ls-files -- <path>` 空 = 未跟踪（exit 0、无输出）。只读，不改 index。 */
async function isUntracked(runner: GitRunner, cwd: string, path: string): Promise<boolean> {
  const result = await runner(["ls-files", "--", path], cwd);
  return result.code === 0 && result.stdout.trim() === "";
}

/** 当前分支短名（`rev-parse --abbrev-ref HEAD`，如 `feat/focus-mode`）；不是仓库 / 分离头 / 出错都 null */
async function currentBranch(runner: GitRunner, cwd: string): Promise<string | null> {
  try {
    const result = await runner(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (result.code !== 0) return null;
    const name = result.stdout.trim();
    // 分离头时输出 "HEAD"，不是可读的分支名——不标比标错好
    return name === "" || name === "HEAD" ? null : name;
  } catch {
    return null;
  }
}

/** numstat 行级统计的合并型：两条 diff（未暂存 + 已暂存）同路径加在一起 */
interface LineStat {
  added: number;
  removed: number;
  binary: boolean;
}

function mergeLineStat(into: Map<string, LineStat>, entries: readonly ReviewEntry[]): void {
  for (const entry of entries) {
    const prev = into.get(entry.path) ?? { added: 0, removed: 0, binary: false };
    into.set(entry.path, {
      added: prev.added + entry.added,
      removed: prev.removed + entry.removed,
      binary: prev.binary || entry.binary,
    });
  }
}

/** XY 有一侧是 A（新增）就是新文件（U），其余已跟踪改动算修改（M） */
function changeKindOf(xy: string): FocusChangeEntry["kind"] {
  return xy.includes("A") ? "U" : "M";
}

/**
 * 单文件行数统计的上限：1 MB。超过就只读开头判二进制、不数行（UI 显示「行数未知」）。
 * 理由：数行要把全文读进内存再 split，而专注左栏 30 秒问一遍全部未跟踪文件——
 * 生成物 / 日志 / 数据动辄几十 MB，为悬停才看的一个数字读它们是这条路径最贵的一步；
 * 1 MB 覆盖源码文本的绝大多数，越线的文件多半本来也不是「数行数」的对象。
 */
const FOCUS_LINE_COUNT_MAX_BYTES = 1024 * 1024;

/** 判二进制只需开头这么多字节（git 的二进制嗅探同样只看前 8000 字节） */
const FOCUS_BINARY_SNIFF_BYTES = 8 * 1024;

/** 未跟踪文件的面（专注扫描的注入点）：stat 定缓存键，read 按大小决定读全文还是读头 */
export interface UntrackedFileStat {
  size: number;
  mtimeMs: number;
}

export interface UntrackedProbe {
  stat(path: string): Promise<UntrackedFileStat | null>;
  /** maxBytes = null → 读全文；否则只读开头这么多字节 */
  read(path: string, maxBytes: number | null): Promise<Buffer | null>;
}

const diskUntrackedProbe: UntrackedProbe = {
  async stat(path) {
    try {
      const info = await stat(path);
      return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  async read(path, maxBytes) {
    try {
      if (maxBytes === null) return await readFile(path);
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  },
};

/** 未跟踪文件的行级统计（专注扫描的一行；lineCountUnknown 见 FOCUS_LINE_COUNT_MAX_BYTES） */
interface UntrackedLineStat {
  added: number;
  binary: boolean;
  lineCountUnknown?: boolean;
}

/**
 * 未跟踪文件行数的缓存：键 = 绝对路径 + size + mtimeMs。专注左栏每 30 秒问一遍
 * 全部未跟踪文件，而文件大多没变——不缓存时每轮把 29 MB 全文读一遍（实测 300 个
 * 文件约 0.3 s）。size 与 mtime 都没动就复用上次的结论，只花一次 stat。
 * 容量上限 2000 是防无界增长的闸：超了按 LRU 淘汰最久没被问到的。
 */
const UNTRACKED_LINE_CACHE_LIMIT = 2000;
const untrackedLineCache = new Map<string, UntrackedLineStat>();

function rememberUntrackedLine(key: string, lineStat: UntrackedLineStat): UntrackedLineStat {
  // 命中也要先删再塞：Map 的迭代顺序 = 插入顺序，队首永远是最久没被问到的
  untrackedLineCache.delete(key);
  untrackedLineCache.set(key, lineStat);
  while (untrackedLineCache.size > UNTRACKED_LINE_CACHE_LIMIT) {
    const oldest = untrackedLineCache.keys().next().value;
    if (oldest === undefined) break;
    untrackedLineCache.delete(oldest);
  }
  return lineStat;
}

/**
 * 「对着空文件算」的行数：与 `createTwoFilesPatch("", content)` 的 `+` 行数同口径
 * （末尾换行不额外算一行），但不跑 diff 算法——这条路径上每轮几百个文件，纯计数只扫一遍。
 */
function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

/** 一个未跟踪文件的行级统计；null = 读不了（刚被删 / 不是文件） */
async function untrackedLineStat(
  path: string,
  probe: UntrackedProbe,
): Promise<UntrackedLineStat | null> {
  const info = await probe.stat(path);
  if (info === null) return null;
  const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`;
  const hit = untrackedLineCache.get(key);
  if (hit !== undefined) return rememberUntrackedLine(key, hit);

  const oversized = info.size > FOCUS_LINE_COUNT_MAX_BYTES;
  // 二进制判定与行数统计共用这一次读盘：小文件读一次全文（既判 NUL 又数行）；
  // 大文件只读头 8 KB，NUL 在开头都没有就按文本处理、行数记「未知」
  const bytes = await probe.read(path, oversized ? FOCUS_BINARY_SNIFF_BYTES : null);
  if (bytes === null) return null;
  if (bytes.includes(0)) return rememberUntrackedLine(key, { added: 0, binary: true });
  if (oversized) {
    return rememberUntrackedLine(key, { added: 0, binary: false, lineCountUnknown: true });
  }
  return rememberUntrackedLine(key, { added: countLines(bytes.toString("utf8")), binary: false });
}

/**
 * `focus:changes` 的 git 侧实现：工作区**尚未提交**的全部改动（VS Code 源代码管理的口径，
 * 不是审查面板 unstaged 那一档）——`status --porcelain=v2` 一遍拿全量清单，
 * 行级统计用未暂存 + 已暂存两条 `diff --numstat` 合并，未跟踪文件对着空文件算
 * （行数按 size+mtime 缓存，超大文件只读头不数行，见 untrackedLineStat）。全部只读。
 */
export async function gitWorkdirChanges(
  runner: GitRunner,
  cwd: string,
  probe: UntrackedProbe = diskUntrackedProbe,
): Promise<FocusChanges> {
  let root: string | null;
  try {
    root = await repoRoot(runner, cwd);
  } catch {
    return { kind: "empty", reason: "no-git" };
  }
  if (root === null) return { kind: "empty", reason: "not-repo" };

  // --no-renames：status 不产 `2 <XY> … old\tnew` 改名行，parseStatusChangedLine 只认 `1` 行
  const status = await runner(
    ["status", "--porcelain=v2", "--untracked-files=all", "--no-renames"],
    cwd,
  );
  const stats = new Map<string, LineStat>();
  mergeLineStat(stats, numstatEntries((await runner(diffArgs("unstaged", null, { numstat: true }) ?? [], cwd)).stdout));
  mergeLineStat(
    stats,
    numstatEntries((await runner(diffArgs("staged", null, { numstat: true }) ?? [], cwd)).stdout),
  );
  // 未跟踪文件不在 git diff 的覆盖面里，行数对着空文件算（读盘面可注入，测试喂假货）
  const untrackedStats = new Map<string, UntrackedLineStat>();
  for (const line of status.stdout.split("\n")) {
    const path = parseUntrackedLine(line);
    if (path === null || !insideWorkspace(path)) continue;
    const lineStat = await untrackedLineStat(`${cwd}/${path}`, probe);
    if (lineStat !== null) untrackedStats.set(path, lineStat);
  }

  const entries: FocusChangeEntry[] = [];
  for (const line of status.stdout.split("\n")) {
    const untrackedPath = parseUntrackedLine(line);
    if (untrackedPath !== null) {
      if (!insideWorkspace(untrackedPath)) continue;
      const fromDisk = untrackedStats.get(untrackedPath);
      // 读盘失败（刚被删 / 二进制读不了）的未跟踪文件不在 untrackedStats 里——
      // status 快照与磁盘现状之间的窗口，不值得报错；行数落 0 但 U 标记保留
      entries.push({
        path: untrackedPath,
        kind: "U",
        added: fromDisk?.added ?? 0,
        removed: 0,
        binary: fromDisk?.binary ?? false,
        // 只在真未知时带上字段：IPC 上少一个键，老 renderer 走原路
        ...(fromDisk?.lineCountUnknown === true ? { lineCountUnknown: true } : {}),
      });
      continue;
    }
    const changed = parseStatusChangedLine(line);
    if (changed === null || !insideWorkspace(changed.path)) continue;
    const stat = stats.get(changed.path);
    entries.push({
      path: changed.path,
      kind: changeKindOf(changed.xy),
      added: stat?.added ?? 0,
      removed: stat?.removed ?? 0,
      binary: stat?.binary ?? false,
    });
  }
  // status 与 diff（--relative）现在都是工作区相对路径，直接就是这棵树要的形态；
  // 工作区之外的改动已在上面按 `../` 前缀与 --relative 排除
  return { kind: "ok", branch: await currentBranch(runner, cwd), entries };
}

/** `review:diff` 的 git 侧实现（unified diff 原样返回）。 */
export async function gitReviewDiff(
  runner: GitRunner,
  cwd: string,
  source: ReviewSource,
  path: string,
  readUntracked: UntrackedReader = diskUntrackedReader,
): Promise<ReviewDiff> {
  const upstream = source === "branch" ? await upstreamName(runner, cwd) : null;
  const args = diffArgs(source, upstream, { path });
  if (args === null) return { diff: null, binary: false, restored: false };
  const result = await runner(args, cwd);
  let diff = result.stdout.trimEnd();
  // 未跟踪文件不在 git diff 的覆盖面里（恒空输出）——曾把空正文当 restored，新建文件
  // 被说成「与基线一致」。列表侧（untrackedEntries）把它算全量新增，正文侧同口径：
  // 读盘对着空文件造一份 diff（带 NUL 的按 binary 处理，同列表侧）。
  if (diff === "" && source === "unstaged" && (await isUntracked(runner, cwd, path))) {
    const bytes = await readUntracked(`${cwd}/${path}`);
    if (bytes !== null) {
      if (bytes.includes(0)) return { diff: null, binary: true, restored: false };
      diff = createTwoFilesPatch("/dev/null", path, "", bytes.toString("utf8"));
    }
  }
  return { diff: diff === "" ? null : diff, binary: false, restored: diff === "" };
}
