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
import { createTwoFilesPatch } from "diff";
import {
  parseNumstatLine,
  parseUntrackedLine,
  type ReviewDiff,
  type ReviewEntry,
  type ReviewList,
  type ReviewSource,
} from "../../shared/review.ts";

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

/** `review:diff` 的 git 侧实现（unified diff 原样返回）。 */
export async function gitReviewDiff(
  runner: GitRunner,
  cwd: string,
  source: ReviewSource,
  path: string,
): Promise<ReviewDiff> {
  const upstream = source === "branch" ? await upstreamName(runner, cwd) : null;
  const args = diffArgs(source, upstream, { path });
  if (args === null) return { diff: null, binary: false, restored: false };
  const result = await runner(args, cwd);
  const diff = result.stdout.trimEnd();
  return { diff: diff === "" ? null : diff, binary: false, restored: diff === "" };
}
