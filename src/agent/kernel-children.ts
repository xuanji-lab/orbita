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
 * 只在 macOS 实现；Windows 上 bash 子进程随 kernel 进程退出的行为未验证，这里不做。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

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

/** 杀掉挂着这个标签的全部进程（连进程组）；返回杀了几个。非 macOS 直接返回 0 */
export function reapKernelChildren(tag: string): Promise<number> {
  if (process.platform !== "darwin") return Promise.resolve(0);
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
