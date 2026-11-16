/**
 * kernel 进程拉起的 shell 子进程的善后：kernel 进程被 kill -9（或随主进程一起被杀）时，bash 工具起的进程组
 * （pi 用 detached spawn，各自一个进程组）不会跟着死，成了孤儿。
 *
 * 做法：kernel 进程给 bash 工具起的每个 shell 的命令前面加一行 `trap ': ORBITA_KERNEL_CHILD=<标签>' EXIT`（spawnHook），
 * 标签由库目录算出（同一个 userData 只有一个 kernel 进程，不同的开发实例互不相干）。kernel 进程异常退出时主进程、
 * 以及 kernel 进程下一次启动时（上一次连主进程一起被杀的情形），按命令行里的标签找出还活着的 shell，连它的进程组
 * （pi 用 detached spawn，shell 是组长，它起的进程都在组里）一起杀掉。
 * 为什么是命令行而不是环境变量：macOS 上系统自带的 /bin/bash、/bin/sleep 受 SIP 保护，`ps -E` 看不到它们的环境变量
 * （2026-11-14 实测）；命令行看得到。为什么是 EXIT trap：有 EXIT trap 的 bash 不会把最后一条命令 exec 掉（否则 shell
 * 进程变成那条命令、命令行里的标签就没了），`:` 也不改退出码。认人靠标签而不是 pid 表：pid 会被系统复用。
 *
 * macOS 按进程组杀。**Windows 另一套**（2026-11-17 Windows 真机验收：停止 `sleep 300` 后 bash.exe 没了、sleep.exe 还在；
 * 强杀后重开也没有「清掉上一次留下的」这一行——原先这里在非 macOS 上直接返回 0）：
 * - Windows 没有进程组，`ps -o pgid` 与 `kill(-pgid)` 都无从谈起；pi-durable 在 Windows 上停命令用的是
 *   `taskkill /F /T /PID <bash>`，它沿 **Windows 的父进程号**找子孙。
 * - Git Bash 是 MSYS（Cygwin 系）运行时，exec 是仿真的：exec 一个 MSYS 程序（sleep.exe）会新起一个 Windows 进程，
 *   原进程随后退出，新进程的 Windows 父进程号指向一个已经不在的进程——taskkill /T 的树在这里断开，sleep.exe 漏网。
 *   exec 原生程序（node.exe、bun.exe）时 MSYS 留着原进程等它结束，树不断，所以真实任务里 bun / node 都清干净了。
 *   （推断，与真机现象吻合：断的只有 MSYS 程序；待 Windows 真机用父进程号核实，步骤见报告。）
 * - 所以 Windows 上不靠进程树，靠 **MSYS 自己的进程表**：bash 工具每次运行在环境变量里挂 `ORBITA_KERNEL_RUN=<标签>.<运行 id>`
 *   （子孙进程原样继承，exec 也不丢），要清的时候用**同一个** bash 起一段脚本（MSYS_REAP_SCRIPT）扫 `/proc/<pid>/environ`
 *   与 `/proc/<pid>/cmdline`，命中的用 bash 内建 kill -9 杀掉。停一条命令按「标签.运行 id」精确匹配；孤儿善后按「标签.」前缀，
 *   外加命令行里的 EXIT trap 标签兜底（environ 读不到时至少杀掉顶层 shell）。
 * - 不用 Job Object：要原生模块或 PowerShell 里 P/Invoke 编译 C#（每次停止多花一两秒、还受执行策略影响），而且进程得在起的那一刻
 *   放进 Job——spawn 在 pi-durable 里，我们够不着；Job 也管不到 kernel 被强杀后的孤儿（除非设 KILL_ON_JOB_CLOSE，同样要原生句柄）。
 *   不用 `wmic`：Windows 11 24H2 起默认没装。PowerShell `Get-CimInstance` 能列命令行，但 sleep.exe 的命令行里没有标签，认不出。
 * Linux 不做（没有出现过，行为未验证）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { findBash } from "./shell-path.ts";

export const KERNEL_CHILD_MARK = "ORBITA_KERNEL_CHILD";

/** 给 shell 命令打标签（spawnHook 用）：前面加一行 EXIT trap，命令本身一字不动 */
export function tagShellCommand(command: string, tag: string): string {
  return `trap ': ${KERNEL_CHILD_MARK}=${tag}' EXIT\n${command}`;
}

/** 库目录 → 子进程标签 */
export function kernelChildTag(durableDir: string): string {
  return `orbita-${createHash("sha256").update(durableDir).digest("hex").slice(0, 16)}`;
}

/** `ps -A -ww -o pid=,pgid=,command=` 的输出里命令行带着这个标签的进程（pid, pgid） */
export function taggedProcesses(psOutput: string, tag: string, self: number): { pid: number; pgid: number }[] {
  const marker = `${KERNEL_CHILD_MARK}=${tag}`;
  const found: { pid: number; pgid: number }[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.includes(marker)) continue;
    const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === self) continue;
    found.push({ pid, pgid: Number(match[2]) });
  }
  return found;
}

/** Windows：bash 工具每次运行挂在环境变量里的标记（子孙进程继承）；值是 `<标签>.<运行 id>`（不用冒号：MSYS 会把像路径列表的值当路径转换） */
export const KERNEL_RUN_ENV = "ORBITA_KERNEL_RUN";

/** 环境变量条目的前缀：给了运行 id 是这一次运行，没给是这个库目录的全部运行 */
export function kernelRunMark(tag: string, run?: string): string {
  return `${KERNEL_RUN_ENV}=${tag}.${run ?? ""}`;
}

/**
 * 在 MSYS / Git Bash 里跑的收割脚本：扫 `/proc`（MSYS 自己的进程表，含 exec 之后 Windows 父子关系已断的进程），
 * environ 里有一条以 ORBITA_REAP_ENV 开头、或 cmdline 里有一个参数含 ORBITA_REAP_CMD 的，kill -9；最后打印杀了几个。
 * 标记经环境变量传进来（不放命令行）：免得自己（与包着它的 Git\bin\bash.exe）的命令行里带着标记被自己扫到。
 * 只用 bash 内建（read / case / kill），不为每个进程 fork grep——Windows 上 fork 一次几十毫秒。
 * ORBITA_REAP_PROC 只给测试用（在 macOS 上拿一个假的 /proc 目录跑这段脚本）。
 */
export const MSYS_REAP_SCRIPT = [
  'proc="${ORBITA_REAP_PROC:-/proc}"; env_mark="$ORBITA_REAP_ENV"; cmd_mark="$ORBITA_REAP_CMD"; n=0',
  'for d in "$proc"/[0-9]*; do',
  '  [ -d "$d" ] || continue',
  '  pid="${d##*/}"',
  '  [ "$pid" = "$$" ] && continue',
  '  hit=""',
  '  if [ -n "$env_mark" ] && [ -r "$d/environ" ]; then',
  '    while IFS= read -r -d "" kv || [ -n "$kv" ]; do case "$kv" in "$env_mark"*) hit=1; break ;; esac; done 2>/dev/null < "$d/environ"',
  '  fi',
  '  if [ -z "$hit" ] && [ -n "$cmd_mark" ] && [ -r "$d/cmdline" ]; then',
  '    while IFS= read -r -d "" arg || [ -n "$arg" ]; do case "$arg" in *"$cmd_mark"*) hit=1; break ;; esac; done 2>/dev/null < "$d/cmdline"',
  '  fi',
  '  if [ -n "$hit" ] && kill -9 "$pid" 2>/dev/null; then n=$((n+1)); fi',
  "done",
  'echo "$n"',
].join("\n");

/** 收割脚本要找的东西：environ 条目前缀（必给）与命令行片段（孤儿善后时给 EXIT trap 的标签） */
export interface MsysReapMarks {
  env: string;
  cmd?: string;
}

/** 起收割脚本的命令（测试注入）：program + args + 环境变量；回调拿到 stdout */
export type ReapRunner = (program: string, args: readonly string[], env: Record<string, string>, done: (error: Error | null, stdout: string) => void) => void;

const execRunner: ReapRunner = (program, args, env, done) => {
  execFile(program, [...args], { env, windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => done(error, String(stdout)));
};

/** 收割脚本的环境：本进程的环境去掉继承来的运行标记（别让脚本自己像个目标），再写上要找的标记 */
export function msysReapEnv(base: NodeJS.ProcessEnv, marks: MsysReapMarks): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && key !== KERNEL_RUN_ENV) env[key] = value;
  env["ORBITA_REAP_ENV"] = marks.env;
  if (marks.cmd !== undefined) env["ORBITA_REAP_CMD"] = marks.cmd;
  return env;
}

/**
 * 用 MSYS bash（必须是跑命令的那一套：MSYS 的 /proc 只看得到同一个运行时的进程）跑收割脚本；返回杀了几个。
 * 起不来 / 超时 / 输出不是数字都当 0，并记一行日志——收割是善后，不该把调用方带崩。
 */
export function reapMsysProcesses(shell: string, marks: MsysReapMarks, run: ReapRunner = execRunner): Promise<number> {
  return new Promise((resolve) => {
    run(shell, ["-c", MSYS_REAP_SCRIPT], msysReapEnv(process.env, marks), (error, stdout) => {
      if (error !== null) {
        console.error("[kernel-children] MSYS 收割脚本失败，孤儿进程没清", error);
        resolve(0);
        return;
      }
      const count = Number(stdout.trim().split("\n").pop());
      resolve(Number.isInteger(count) && count >= 0 ? count : 0);
    });
  });
}

/** 注入点（测试）：平台、Windows 上用哪个 bash、怎么起收割脚本 */
export interface ReapOptions {
  platform?: NodeJS.Platform;
  /** Windows：跑收割脚本的 bash；默认 findBash()（与 bash 工具默认用的同一个） */
  shell?: string;
  run?: ReapRunner;
}

/**
 * 杀掉挂着这个标签的全部进程；返回杀了几个。macOS 连进程组杀；Windows 经 MSYS 的 /proc 按运行标记与 EXIT trap 标签杀
 * （找不到 bash 返回 0）；其它平台返回 0。
 */
export function reapKernelChildren(tag: string, options: ReapOptions = {}): Promise<number> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const shell = options.shell ?? findBash(platform);
    if (shell === undefined) return Promise.resolve(0);
    return reapMsysProcesses(shell, { env: kernelRunMark(tag), cmd: `${KERNEL_CHILD_MARK}=${tag}` }, options.run);
  }
  if (platform !== "darwin") return Promise.resolve(0);
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-ww", "-o", "pid=,pgid=,command="], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        console.error("[kernel-children] ps 失败，孤儿进程没清", error);
        resolve(0);
        return;
      }
      const found = taggedProcesses(stdout, tag, process.pid);
      for (const { pid, pgid } of found) {
        try {
          if (pgid > 1) process.kill(-pgid, "SIGKILL");
        } catch {
          // 进程组已经没了：再试单个进程
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 已经退出
        }
      }
      resolve(found.length);
    });
  });
}
