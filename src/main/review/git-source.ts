/**
 * 审查面板的 git 只读来源 —— git CLI 的薄封装（只跑 status / diff / rev-parse，
 * 绝不写）。空态分类（没有 git / 不是仓库 / 没有 upstream）在这里判好，面板只管显示。
 *
 * 注入 runner：node --test 可以喂假 git；真实 runner 用 execFile（不带 shell，
 * 参数走数组——路径里有空格 / `--` 都不会被曲解）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
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

/** 未跟踪文件（porcelain v2 的 `? ` 行）：行数对着空文件算，二进制标 binary。 */
async function untrackedEntries(
  cwd: string,
  statusStdout: string,
  read: UntrackedReader = diskUntrackedReader,
): Promise<ReviewEntry[]> {
  const entries: ReviewEntry[] = [];
  for (const line of statusStdout.split("\n")) {
    const path = parseUntrackedLine(line);
    if (path === null) continue;
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
  if (source === "unstaged") return ["diff", "--no-renames", ...numstat, ...pathArg];
  if (source === "staged") return ["diff", "--cached", "--no-renames", ...numstat, ...pathArg];
  if (source === "branch") {
    if (upstream === null) return null;
    return ["diff", "--no-renames", ...numstat, `${upstream}...HEAD`, ...pathArg];
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
 * `focus:changes` 的 git 侧实现：工作区**尚未提交**的全部改动（VS Code 源代码管理的口径，
 * 不是审查面板 unstaged 那一档）——`status --porcelain=v2` 一遍拿全量清单，
 * 行级统计用未暂存 + 已暂存两条 `diff --numstat` 合并，未跟踪文件对着空文件算
 * （同 `gitReviewList` 的 unstaged 支路，同一条 disk 读盘路）。全部只读。
 */
export async function gitWorkdirChanges(
  runner: GitRunner,
  cwd: string,
  readUntracked: UntrackedReader = diskUntrackedReader,
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
    numstatEntries((await runner(["diff", "--cached", "--no-renames", "--numstat"], cwd)).stdout),
  );
  // 未跟踪文件不在 git diff 的覆盖面里，行数对着空文件算（读盘，与审查面板同一条路）
  const untrackedStats = new Map(
    (await untrackedEntries(cwd, status.stdout, readUntracked)).map((entry) => [
      entry.path,
      entry,
    ]),
  );

  const entries: FocusChangeEntry[] = [];
  for (const line of status.stdout.split("\n")) {
    const untrackedPath = parseUntrackedLine(line);
    if (untrackedPath !== null) {
      const fromDisk = untrackedStats.get(untrackedPath);
      // 读盘失败（刚被删 / 二进制读不了）的未跟踪文件不在 untrackedEntries 里——
      // status 快照与磁盘现状之间的窗口，不值得报错；行数落 0 但 U 标记保留
      entries.push({
        path: untrackedPath,
        kind: "U",
        added: fromDisk?.added ?? 0,
        removed: fromDisk?.removed ?? 0,
        binary: fromDisk?.binary ?? false,
      });
      continue;
    }
    const changed = parseStatusChangedLine(line);
    if (changed === null) continue;
    const stat = stats.get(changed.path);
    entries.push({
      path: changed.path,
      kind: changeKindOf(changed.xy),
      added: stat?.added ?? 0,
      removed: stat?.removed ?? 0,
      binary: stat?.binary ?? false,
    });
  }
  // git 路径相对于仓库根；树相对于工作区目录。工作区不是仓库根时（嵌在更大的
  // 仓库里）换算成工作区相对路径，落在工作区之外的改动不归这棵树管，丢掉
  const cwdRelative = (path: string): string | null => {
    const rel = relative(cwd, join(root, path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return sep === "/" ? rel : rel.split(sep).join("/");
  };
  const scoped = [] as FocusChangeEntry[];
  for (const entry of entries) {
    const rel = cwdRelative(entry.path);
    if (rel !== null) scoped.push({ ...entry, path: rel });
  }
  return { kind: "ok", branch: await currentBranch(runner, cwd), entries: scoped };
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
