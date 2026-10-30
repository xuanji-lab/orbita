/**
 * 审查面板的 git 只读来源 —— git CLI 的薄封装（只跑 status / diff / rev-parse，
 * 绝不写）。空态分类（没有 git / 不是仓库 / 没有 upstream）在这里判好，面板只管显示。
 *
 * 注入 runner：node --test 可以喂假 git；真实 runner 用 execFile（不带 shell，
 * 参数走数组——路径里有空格 / `--` 都不会被曲解）。
 *
 * **读盘边界**：`review:diff` 的 path 是 renderer 传来的。只认工作区相对、resolve 后仍在 cwd 下的路径
 * （workspaceRelativePath），不认的连 git 都不跑；未跟踪文件是我们自己读盘（git diff 覆盖不到），
 * 读之前 realpath 再判一次，且 lstat 不跟符号链接——链接只报它指向哪。已跟踪文件的正文由 git
 * 自己读：`--relative` 把输出限在 cwd 之内，已跟踪的链接 git 只比链接里写的目标串、不跟过去。
 *
 * 未跟踪文件的读盘有两条路：列表只要行数（专注左栏与审查列表共用 untracked-lines.ts 的计数器），
 * 展开一个文件时才整份读来造正文（diskUntrackedReader，只给 review:diff）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import { dirname, posix, resolve, win32 } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  parseNumstatLine,
  parseStatusChangedLine,
  parseUntrackedLine,
  reviewDiffError,
  reviewDiffOverflow,
  reviewDiffTooLarge,
  REVIEW_DIFF_MAX_BYTES,
  REVIEW_DIFF_MAX_LINES,
  type ReviewDiff,
  type ReviewEntry,
  type ReviewList,
  type ReviewSource,
} from "../../shared/review.ts";
import type { FocusChangeEntry, FocusChanges } from "../../shared/focus.ts";
import { isInside, realpathInside } from "../path-boundary.ts";
import { diskUntrackedProbe, GIT_BINARY_SNIFF_BYTES, untrackedLineStats, type UntrackedProbe } from "./untracked-lines.ts";

const execFileAsync = promisify(execFile);

export interface GitRunOutcome {
  code: number;
  stdout: string;
  /**
   * 输出撞到了 maxBuffer 被拦腰截断（execFile 的 ERR_CHILD_PROCESS_STDIO_MAXBUFFER）：
   * stdout 只有前半份，code 被折成 1。以前这个情形被当普通非零码静默吞掉——
   * 部分输出被当成完整结果用（列表少文件、diff 少 hunk）。调用方必须看它：
   * 列表侧如实报错，diff 正文侧翻译成「改动太大」。
   */
  truncated?: boolean;
}

/**
 * 退出码非 0 不是异常（not-repo / no-upstream 都用它表达）；两种情况抛给上层：
 * ENOENT（没有 git，上层翻成 no-git 空态）与超时（GitTimeoutError，上层如实报错）。
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunOutcome>;

/**
 * 单条 git 命令的时限：60 秒。git 会卡住（网络盘挂了、fsmonitor 钩子不返回、杀毒软件锁着文件），
 * 卡住的那一轮不该永远等下去——专注左栏的轮询一旦做了「上一轮没回来不发下一轮」，一次卡死就是
 * 永远不再刷新。60 秒远长于正常的 status / diff（大仓库也是秒级），只拦真的卡死。
 */
const GIT_TIMEOUT_MS = 60_000;

/**
 * git 跑超时被杀。不折成退出码：那样会被读成「不是仓库」「没有改动」，界面说错话；
 * 抛到 IPC 层变成 error 回执，界面显示原因。
 */
export class GitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitTimeoutError";
  }
}

/** 报错里的子命令名：跳过开头的 `-c 键=值`（status 前面带着它们） */
function subcommandOf(args: readonly string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

/** 带时限的真 git runner（execFile，不带 shell）。测试用短时限造卡死；应用里只用 realGitRunner */
export function gitRunnerWithTimeout(timeoutMs: number, maxBufferBytes = 32 * 1024 * 1024): GitRunner {
  return async (args, cwd) => {
    try {
      // -c core.quotepath=false：非 ASCII 路径原样输出。git 默认把中文路径 C 转义成
      // `"\344\270\255.txt"`——未跟踪文件读盘 ENOENT 被静默跳过、已跟踪文件拉空 diff
      // 误显「与基线一致」。加在 runner 一处，rev-parse / status / diff 全部生效。
      const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
        cwd,
        maxBuffer: maxBufferBytes,
        encoding: "utf8",
        // 到点 execFile 发 SIGTERM（Windows 上直接结束进程），error.killed = true
        timeout: timeoutMs,
      });
      return { code: 0, stdout };
    } catch (cause) {
      // 非零退出码不是异常（not-repo / no-upstream 靠它表达）：stdout 在 error 上原样带回；
      // ENOENT（没有 git）重新抛，上层翻成 no-git 空态
      const failure = cause as {
        code?: number | string | null;
        stdout?: string;
        errno?: string;
        killed?: boolean;
      };
      if (failure.code === "ENOENT" || failure.errno === "ENOENT") throw cause;
      // maxBuffer 溢出要先于 killed 判：溢出也会发信号杀进程，killed 同样为 true
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return { code: 1, stdout: failure.stdout ?? "", truncated: true };
      }
      // killed 只在我们自己发信号时为 true（这里只有超时会发；maxBuffer 溢出已在上面分流）
      if (failure.killed === true) {
        throw new GitTimeoutError(`git ${subcommandOf(args)} timed out after ${Math.round(timeoutMs / 1000)} s`);
      }
      return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "" };
    }
  };
}

export const realGitRunner: GitRunner = gitRunnerWithTimeout(GIT_TIMEOUT_MS);

/**
 * diff 正文专用的 runner：maxBuffer 收到上限的两倍（2 MB）。超过正文上限的 diff 本来就不该
 * 生成——用共享 runner（32 MB）拉一个 50 MB 的改动，主进程会先在整个 32 MB 的缓冲里攒满
 * 再被杀，白做一遍；收小后最坏只攢 2 MB，撞顶即判「改动太大」。status / numstat 输出
 * 与改动体积无关（一行一个文件），仍用 realGitRunner。
 */
export const realDiffRunner: GitRunner = gitRunnerWithTimeout(GIT_TIMEOUT_MS, REVIEW_DIFF_MAX_BYTES * 2);

/**
 * 专注左栏与审查面板（unstaged）的 status 是同一组参数，两处共用这一份（以前各写一遍，审查那边
 * 少了 --no-renames；目前只读 `?` 行所以没出事，但参数漂移迟早咬人）：
 * - `-c status.relativePaths=true`：路径口径钉成「工作区相对」。`git diff` 用 --relative 强制，
 *   status 没有这个参数，由配置决定（默认 true，用户可设 false）。不钉死，子目录工作区会遇到
 *   「diff 是 a.txt、status 是 sub/a.txt / ../x」两套路径（2026-10-25 合作者实测）。
 * - `--untracked-files=all`：未跟踪目录展开成文件，逐个数行。
 * - `--no-renames`：不产 `2 <XY> … old\tnew` 改名行（parseStatusChangedLine 只认 `1` 行），
 *   也省掉改名检测。
 */
const STATUS_ARGS = [
  "-c",
  "status.relativePaths=true",
  "status",
  "--porcelain=v2",
  "--untracked-files=all",
  "--no-renames",
];

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

/**
 * 未跟踪路径在盘上的样子：普通文件给字节；符号链接只给链接里写的目标（readlink 原文），
 * 不跟过去；realpath 后跑出工作区的给 outside；超过正文上限的普通文件给 tooLarge
 * （只读开头判过二进制，没有整读）；开头有 NUL 的超大文件给 binary（同样只读了开头）。
 */
export type UntrackedRead = Buffer | { symlink: string } | { outside: true } | { tooLarge: true } | { binary: true };

/**
 * 未跟踪文件正文的读盘面（review:diff 展开一个文件时用；测试注入假货）：null = 读不了 / 不是文件。
 * workspace 给了 = 路径来自 renderer，读之前先 realpath 判所在目录仍在工作区里。
 * 列表只数行、不走这里（untracked-lines.ts）：列表的路径是 git status 给的（git 不进链接目录，
 * 只把链接本身当一项列），省掉这两次 realpath——2000 个未跟踪文件实测要多 84 ms，而专注左栏
 * 30 秒就整轮问一遍。
 *
 * 超过 REVIEW_DIFF_MAX_BYTES 的文件不整读：patch 至少和文件一样大，读了也出不了正文。
 * 只读开头 GIT_BINARY_SNIFF_BYTES 字节判二进制（同 git 口径）：是二进制如实报 binary
 * （50 MB 的视频谈不到「太大」），是文本才报 tooLarge。
 */
export type UntrackedReader = (path: string, workspace?: string) => Promise<UntrackedRead | null>;

const diskUntrackedReader: UntrackedReader = async (path, workspace) => {
  try {
    // 路径中间某一级目录是链接（linkdir/x.txt）：词法上在工作区里，realpath 后在外面。
    // git status 不会列出这种路径，但 renderer 可以直接传（未修前实测：`git ls-files` 照样判它未跟踪）
    if (workspace !== undefined && (await realpathInside(dirname(path), [workspace])) === null) {
      return { outside: true };
    }
    // lstat 不跟链接：链接本身是什么就报什么。跟过去的话，一个指向工作区外的未跟踪链接
    // 就能把外面任意文件读进面板（Windows 的 junction 在 Node 里同样是 isSymbolicLink）
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { symlink: await readlink(path) };
    if (!info.isFile()) return null;
    if (info.size <= REVIEW_DIFF_MAX_BYTES) return await readFile(path);
    const sniffed = await readHead(path, GIT_BINARY_SNIFF_BYTES);
    return sniffed === null ? null : sniffed.includes(0) ? { binary: true } : { tooLarge: true };
  } catch {
    return null;
  }
};

/** 只读开头至多 length 字节（判二进制用）：打不开 / 读不了返回 null */
async function readHead(path: string, length: number): Promise<Buffer | null> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return read === length ? buffer : buffer.subarray(0, read);
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/**
 * renderer 传来的路径能不能当这个工作区里的文件：只认相对路径（列表给的就是工作区相对），
 * resolve 之后必须严格落在 cwd 之下。绝对路径（POSIX 与 Windows 两种形都算，含盘符 / UNC）、
 * 空串、`.`、`../` 跑出去的一律不认；含 NUL 的串同样不认。只做词法判断、不碰盘——
 * realpath 那道在真正读盘的地方（未跟踪文件分支）。认了返回 resolve 后的绝对路径。
 */
function workspaceRelativePath(cwd: string, path: string): string | null {
  if (path === "" || path.includes("\0") || posix.isAbsolute(path) || win32.isAbsolute(path)) return null;
  const full = resolve(cwd, path);
  if (full === resolve(cwd) || !isInside(cwd, full)) return null;
  return full;
}

/**
 * status 的路径默认就是工作区相对（git 1.5.4 起），但工作区之外的改动会带 `../` 前缀
 * ——不归这棵树管（与 `git diff --relative` 的排除口径一致）。git 只输出 `/` 分隔。
 */
function insideWorkspace(path: string): boolean {
  return path !== ".." && !path.startsWith("../");
}

/**
 * 未跟踪文件（porcelain v2 的 `? ` 行）：行数对着空文件算，二进制标 binary，符号链接只报指向哪。
 * 审查列表（unstaged）与专注左栏（gitWorkdirChanges）都走这里，数行数是 untrackedLineStats 一处实现——
 * 同一文件两边给同一个数，且都吃同一份缓存（以前这里整份读文件 + 造 diff 数 `+`：50 MB 要 0.5–1 秒）。
 * 一次把 status 列出的全部未跟踪文件交给计数器：缓存按「上一轮」记，必须是全集。
 */
async function untrackedEntries(
  cwd: string,
  statusStdout: string,
  probe: UntrackedProbe = diskUntrackedProbe,
): Promise<ReviewEntry[]> {
  const paths: string[] = [];
  for (const line of statusStdout.split("\n")) {
    const path = parseUntrackedLine(line);
    if (path !== null && insideWorkspace(path)) paths.push(path);
  }
  const lineStats = await untrackedLineStats(cwd, paths, probe);
  const entries: ReviewEntry[] = [];
  for (const path of paths) {
    const lineStat = lineStats.get(path);
    // 刚被删 / 读不了：跳过——status 快照与磁盘现状之间的窗口，不值得报错
    if (lineStat === undefined) continue;
    if (lineStat.symlink !== undefined) {
      // 链接不跟：行数不算目标的，只标出它是链接、指向哪
      entries.push({ path, added: 0, removed: 0, binary: false, symlink: lineStat.symlink });
      continue;
    }
    entries.push({
      path,
      added: lineStat.added,
      removed: 0,
      binary: lineStat.binary,
      // 只在真未知时带上字段：超限文件 added 是 0，但 UI 不能拿 +0 冒充没改动
      ...(lineStat.lineCountUnknown === true ? { lineCountUnknown: true } : {}),
    });
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

/**
 * `review:list` 里 status / numstat 一类「输出会被当清单用」的调用：code 非 0 或输出被
 * maxBuffer 截断都不是「没有改动」，如实报错。rev-parse（not-repo / no-upstream 靠退出码
 * 表达）不走这里。
 */
async function runForList(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  const result = await runner(args, cwd);
  if (result.code === 0 && result.truncated !== true) return { ok: true, stdout: result.stdout };
  const cut = result.truncated === true ? " (output hit the runner's buffer cap and was cut short)" : "";
  return { ok: false, message: `git ${subcommandOf(args)} exited with code ${result.code}${cut}` };
}

/** `review:list` 的 git 侧实现。probe 只为测试注入（未跟踪文件的读盘面）。 */
export async function gitReviewList(
  runner: GitRunner,
  cwd: string,
  source: ReviewSource,
  probe: UntrackedProbe = diskUntrackedProbe,
): Promise<ReviewList> {
  let root: string | null;
  try {
    root = await repoRoot(runner, cwd);
  } catch (cause) {
    // 超时不是「没有 git」：抛给 IPC 层如实报错
    if (cause instanceof GitTimeoutError) throw cause;
    return { kind: "empty", reason: "no-git", cwd };
  }
  if (root === null) return { kind: "empty", reason: "not-repo", cwd };

  if (source === "branch") {
    const upstream = await upstreamName(runner, cwd);
    if (upstream === null) return { kind: "empty", reason: "no-upstream", cwd };
    const args = diffArgs(source, upstream, { numstat: true });
    if (args === null) return { kind: "empty", reason: "no-upstream", cwd };
    const numstat = await runForList(runner, args, cwd);
    if (!numstat.ok) return { kind: "error", message: numstat.message, cwd };
    const entries = numstatEntries(numstat.stdout);
    return entries.length === 0
      ? { kind: "empty", reason: "no-changes", cwd }
      : { kind: "ok", cwd, entries, upstream };
  }

  if (source === "unstaged") {
    // 路径口径与专注左栏同一组 status 参数（STATUS_ARGS 的注释写了为什么要钉死工作区相对）
    const status = await runForList(runner, STATUS_ARGS, cwd);
    if (!status.ok) return { kind: "error", message: status.message, cwd };
    const diff = await runForList(runner, diffArgs(source, null, { numstat: true }) ?? [], cwd);
    if (!diff.ok) return { kind: "error", message: diff.message, cwd };
    const entries = [...numstatEntries(diff.stdout), ...(await untrackedEntries(cwd, status.stdout, probe))];
    if (entries.length === 0) return { kind: "empty", reason: "no-changes", cwd };
    // 同一路径可能两处出现（已改 + 未跟踪不会同路径；稳妥起见去重保序）
    const seen = new Set<string>();
    const unique = entries.filter((entry) => (seen.has(entry.path) ? false : seen.add(entry.path)));
    return { kind: "ok", cwd, entries: unique };
  }

  const diff = await runForList(runner, diffArgs(source, null, { numstat: true }) ?? [], cwd);
  if (!diff.ok) return { kind: "error", message: diff.message, cwd };
  const entries = numstatEntries(diff.stdout);
  return entries.length === 0
    ? { kind: "empty", reason: "no-changes", cwd }
    : { kind: "ok", cwd, entries };
}

/**
 * `git ls-files -- <path>` 空 = 未跟踪（exit 0、无输出）。只读，不改 index。
 * code 非 0（index 坏了之类）地抛——上层如实报错，不能把「判不了」当「已跟踪」
 * 折成空正文误显「已还原」。
 */
async function isUntracked(runner: GitRunner, cwd: string, path: string): Promise<boolean> {
  const result = await runner(["ls-files", "--", path], cwd);
  if (result.code !== 0) throw new Error(`git ls-files exited with code ${result.code}`);
  return result.stdout.trim() === "";
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
 * `focus:changes` 的 git 侧实现：工作区**尚未提交**的全部改动（VS Code 源代码管理的口径，
 * 不是审查面板 unstaged 那一档）——`status --porcelain=v2` 一遍拿全量清单，
 * 行级统计用未暂存 + 已暂存两条 `diff --numstat` 合并，未跟踪文件对着空文件算
 * （与审查面板共用 untrackedLines：size+mtime 缓存，超大文件只读头不数行）。全部只读。
 */
export async function gitWorkdirChanges(
  runner: GitRunner,
  cwd: string,
  probe: UntrackedProbe = diskUntrackedProbe,
): Promise<FocusChanges> {
  let root: string | null;
  try {
    root = await repoRoot(runner, cwd);
  } catch (cause) {
    if (cause instanceof GitTimeoutError) throw cause;
    return { kind: "empty", reason: "no-git" };
  }
  if (root === null) return { kind: "empty", reason: "not-repo" };

  const status = await runner(STATUS_ARGS, cwd);
  const stats = new Map<string, LineStat>();
  mergeLineStat(stats, numstatEntries((await runner(diffArgs("unstaged", null, { numstat: true }) ?? [], cwd)).stdout));
  mergeLineStat(
    stats,
    numstatEntries((await runner(diffArgs("staged", null, { numstat: true }) ?? [], cwd)).stdout),
  );
  // 未跟踪文件不在 git diff 的覆盖面里，行数对着空文件算（与审查面板同一条路：同一个计数器、同一份缓存）
  const untrackedStats = new Map(
    (await untrackedEntries(cwd, status.stdout, probe)).map((entry) => [entry.path, entry]),
  );

  const entries: FocusChangeEntry[] = [];
  for (const line of status.stdout.split("\n")) {
    const untrackedPath = parseUntrackedLine(line);
    if (untrackedPath !== null) {
      if (!insideWorkspace(untrackedPath)) continue;
      const fromDisk = untrackedStats.get(untrackedPath);
      // 读盘失败（刚被删 / 读不了）的未跟踪文件不在 untrackedStats 里——
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

/**
 * `review:diff` 的 git 侧实现（unified diff 原样返回）。path 是 renderer 传来的：先判它在不在
 * 工作区里，不在的连 git 都不跑（审查报告 R06：传 `../x` 曾读到工作区外、仓库内的未跟踪文件）。
 *
 * **先判断再生成**：超过正文上限（REVIEW_DIFF_MAX_*）的改动不读盘、不生成 patch，回
 * 「改动太大」——已跟踪的看 git 拉回来的 diff 本身（拉的时候 maxBuffer 已收小，最坏攢 2 MB
 * 就被拦腰）；未跟踪的看 lstat 的字节数，超限只读开头 8000 字节判二进制。判的是 diff 的
 * 增删行数与字节数，不是文件大小：只改了几行的大文件照常展开。
 */
export async function gitReviewDiff(
  runner: GitRunner,
  cwd: string,
  source: ReviewSource,
  path: string,
  readUntracked: UntrackedReader = diskUntrackedReader,
): Promise<ReviewDiff> {
  const full = workspaceRelativePath(cwd, path);
  if (full === null) {
    return reviewDiffError("outside-workspace", `${JSON.stringify(path)} is not a path inside the workspace ${cwd}`);
  }
  const upstream = source === "branch" ? await upstreamName(runner, cwd) : null;
  const args = diffArgs(source, upstream, { path });
  if (args === null) return { diff: null, binary: false, restored: false };
  const result = await runner(args, cwd);
  // 输出撞 maxBuffer = 改动远超正文上限：被杀时只攢了上限两倍的缓冲，不重拉、不攒了
  if (result.truncated === true) {
    return reviewDiffTooLarge("bytes", `git ${subcommandOf(args)} output hit the buffer cap`);
  }
  if (result.code !== 0) {
    return reviewDiffError("failed", `git ${subcommandOf(args)} exited with code ${result.code}`);
  }
  let diff = result.stdout.trimEnd();
  // 已跟踪改动的正文就是 git 的输出：先判超限，超了这份字符串就是全部成本
  if (diff !== "") {
    const overflow = reviewDiffOverflow(diff);
    if (overflow !== null) {
      return reviewDiffTooLarge(overflow, `the diff for ${path} exceeds the inline limits`);
    }
  }
  // 未跟踪文件不在 git diff 的覆盖面里（恒空输出）——曾把空正文当 restored，新建文件
  // 被说成「与基线一致」。列表侧（untrackedEntries）把它算全量新增，正文侧同口径：
  // 读盘对着空文件造一份 diff（带 NUL 的按 binary 处理，同列表侧）。
  if (diff === "" && source === "unstaged" && (await isUntracked(runner, cwd, path))) {
    const found = await readUntracked(full, cwd);
    if (found !== null) {
      if ("outside" in found) return reviewDiffError("outside-workspace", `${path} resolves outside the workspace ${cwd}`);
      // 未跟踪的符号链接：不跟到目标读（R06 探针二：曾读到仓库外的文件），只报它指向哪
      if ("symlink" in found) return { diff: null, binary: false, restored: false, symlink: found.symlink };
      // 超限的未跟踪文件在读盘面就没整读（只喳了开头判二进制）：视频等二进制如实报 binary
      if ("binary" in found) return { diff: null, binary: true, restored: false };
      if ("tooLarge" in found) {
        return reviewDiffTooLarge("bytes", `${path} is larger than the inline diff limit`);
      }
      if (found.includes(0)) return { diff: null, binary: true, restored: false };
      // 字节没超限但行数超限（极短行）：不用造 patch 就能判——patch 的 + 行数就是文件行数
      if (countLines(found) > REVIEW_DIFF_MAX_LINES) {
        return reviewDiffTooLarge("lines", `${path} has more lines than the inline diff limit`);
      }
      diff = createTwoFilesPatch("/dev/null", path, "", found.toString("utf8"));
      const overflow = reviewDiffOverflow(diff);
      if (overflow !== null) {
        return reviewDiffTooLarge(overflow, `the diff for ${path} exceeds the inline limits`);
      }
    }
  }
  return { diff: diff === "" ? null : diff, binary: false, restored: diff === "" };
}

/** 字节里有多少行（git 口径：最后一个字节不是换行也第一行，同 untracked-lines 的数法） */
function countLines(bytes: Buffer): number {
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) lines += 1;
  }
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}
