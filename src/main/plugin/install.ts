/**
 * 把插件目录弄进暂存区：本地文件夹「复制」与 git 克隆。**暂存而不是直接装**——预览读的就是
 * 暂存区里的内容，用户确认后装上的也是它（rename 进 `plugins/<name>`），预览与安装之间
 * 源目录被改、远端被推新提交都影响不到用户确认过的那一份。
 *
 * 安全面（插件里有能在本机跑的东西，进来的路要窄）：
 * - 复制遇到指向插件根之外的符号链接拒绝（绝对目标、`..` 逃出、真实路径落在根外）。
 *   复制时 `verbatimSymlinks`：相对链接原样保留，不被 Node 默认改写成指回源目录的绝对路径
 *   （那会让副本悄悄依赖源目录，「复制」就名不副实）；
 * - 大小与条目数设上限：用户一个手滑选了家目录，不该把整盘拷进 userData；
 * - git 只收 https 与 ssh；`GIT_ALLOW_PROTOCOL` 再卡一道（子模块、重定向也出不去这两个协议）；
 *   `--` 隔开选项，`-` 开头的「地址」当不合法；`GIT_TERMINAL_PROMPT=0` 不弹交互；带超时。
 */
import { execFile } from "node:child_process";
import { cp, lstat, readdir, readlink, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { PluginPreviewError } from "../../shared/plugin.ts";

const execFileAsync = promisify(execFile);

/** 复制的上限。官方插件实测 ≤ 21 MB / 几百个文件，留两个数量级的余量。 */
export const COPY_MAX_ENTRIES = 20_000;
export const COPY_MAX_BYTES = 300 * 1024 * 1024;

/** 克隆整体超时：`--depth 1` 的小仓库几秒；慢网给到两分钟，再久就是卡死。 */
export const GIT_TIMEOUT_MS = 120_000;

type Staged = { ok: true } | { ok: false; error: PluginPreviewError };

/** 跑一条 git 命令返回 stdout；测试注入假的。 */
export type GitRunner = (args: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<string>;

export const runGit: GitRunner = async (args, options) => {
  const { stdout } = await execFileAsync("git", [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeout: options.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:ssh" },
  });
  return stdout;
};

/**
 * 只收 https 与 ssh：`https://…`、`ssh://…`、scp 式 `user@host:path`。
 * 拒 http / git / file / ext:: 等协议与 `-` 开头（选项注入）。返回规整后的地址（去首尾空白）。
 */
export function checkGitUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === "" || url.startsWith("-") || /\s/.test(url)) return null;
  if (/^https:\/\/[^/\s]+\/\S+/.test(url)) return url;
  if (/^ssh:\/\/[^/\s]+\/\S+/.test(url)) return url;
  // scp 式：user@host:owner/repo.git（冒号后不能是 // —— 那是别的协议）
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url)) return url;
  return null;
}

/** 仓库地址里的名字（插件目录名的兜底）：最后一段去掉 `.git`。 */
export function repoNameOf(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/** 克隆到 `stagingDir`（必须不存在），返回 HEAD 提交。失败清掉暂存目录。 */
export async function stageGit(
  url: string,
  stagingDir: string,
  git: GitRunner,
): Promise<{ ok: true; commit: string } | { ok: false; error: PluginPreviewError }> {
  const checked = checkGitUrl(url);
  if (checked === null) return { ok: false, error: { kind: "git-url-rejected", url } };
  try {
    await git(["clone", "--depth", "1", "--no-tags", "--", checked, stagingDir], { timeoutMs: GIT_TIMEOUT_MS });
    const commit = (await git(["rev-parse", "HEAD"], { cwd: stagingDir, timeoutMs: 30_000 })).trim();
    const escapes = await findEscapingSymlinks(stagingDir);
    if (escapes.length > 0) {
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: false, error: { kind: "symlink-escape", paths: escapes } };
    }
    return { ok: true, commit };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    return { ok: false, error: { kind: "git-failed", message: gitFailure(error) } };
  }
}

/** 超时与普通失败给不同的话；stderr 比 Node 包的那句 `Command failed` 有用得多。 */
function gitFailure(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { killed?: unknown; stderr?: unknown; message?: unknown };
    if (e.killed === true) return "timeout";
    if (typeof e.stderr === "string" && e.stderr.trim() !== "") return e.stderr.trim().split("\n").slice(-3).join("\n");
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

/**
 * 本地文件夹 → 暂存目录（复制）。先在源上数条目与大小（lstat，不跟链接），超限不拷；
 * 拷完在**副本**上查符号链接——副本是我们的地盘，检查对象就是将要装上的那一份。
 * `.git` 不拷（用户的工作仓库历史可能很大，也不是插件内容）。
 */
export async function stageCopy(
  source: string,
  stagingDir: string,
  limits: { entries: number; bytes: number } = { entries: COPY_MAX_ENTRIES, bytes: COPY_MAX_BYTES },
): Promise<Staged> {
  const real = await realpath(source).catch(() => null);
  if (real === null) return { ok: false, error: { kind: "read-failed", message: `${source}: not found` } };
  const info = await lstat(real);
  if (!info.isDirectory()) return { ok: false, error: { kind: "read-failed", message: `${source}: not a folder` } };

  const size = await measure(real, limits);
  if (size.entries > limits.entries || size.bytes > limits.bytes) return { ok: false, error: { kind: "too-large" } };

  try {
    await cp(real, stagingDir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      filter: (path) => !isGitDir(path),
    });
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    return { ok: false, error: { kind: "read-failed", message: error instanceof Error ? error.message : String(error) } };
  }
  const escapes = await findEscapingSymlinks(stagingDir);
  if (escapes.length > 0) {
    await rm(stagingDir, { recursive: true, force: true });
    return { ok: false, error: { kind: "symlink-escape", paths: escapes } };
  }
  return { ok: true };
}

function isGitDir(path: string): boolean {
  return path.split(sep).includes(".git");
}

/** 条目数与字节数（不跟符号链接，跳过 .git）。超限就提前停，不必数完。 */
async function measure(root: string, limits: { entries: number; bytes: number }): Promise<{ entries: number; bytes: number }> {
  let entries = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === ".git") continue;
      entries += 1;
      const path = join(dir, item.name);
      if (item.isDirectory()) stack.push(path);
      else if (item.isFile()) bytes += (await lstat(path)).size;
      if (entries > limits.entries || bytes > limits.bytes) return { entries, bytes };
    }
  }
  return { entries, bytes };
}

/**
 * 根里所有指到根外的符号链接（相对根的路径）。判定两层：
 * 字面——绝对目标一律算逃逸（副本里它仍指向原位置，名义上在根内实际在根外），相对目标
 * 按链接所在目录解析后落在根外算逃逸；
 * 真实——目标存在时再 realpath 一次，链进链出绕一圈落到根外的也抓得住。
 * 不存在的目标（悬空链接）只看字面那层：悬空但字面在根内无害。
 */
export async function findEscapingSymlinks(root: string): Promise<string[]> {
  const realRoot = await realpath(root);
  const inside = (path: string): boolean => path === realRoot || path.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  const escapes: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === ".git") continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!item.isSymbolicLink()) continue;
      const target = await readlink(path);
      const relative = path.slice(root.length + 1);
      if (isAbsolute(target)) {
        escapes.push(relative);
        continue;
      }
      const literal = resolve(await realpath(dirname(path)), target);
      if (!inside(literal)) {
        escapes.push(relative);
        continue;
      }
      const real = await realpath(path).catch(() => null);
      if (real !== null && !inside(real)) escapes.push(relative);
    }
  }
  return escapes.sort();
}
