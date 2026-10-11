/**
 * shell 探测 —— PTY 最终跑哪个可执行文件。**纯模块**：platform / env / 可执行性
 * 判断都可注入，node --test 直接测回退链。runtime 在创建 PTY 时调用它，是
 * 「跑什么 shell」的最终裁决——renderer 与主进程都无权指定任意可执行文件。
 *
 * 回退链（设计共识，不翻案）：
 *   Windows  pwsh → powershell → cmd
 *   POSIX    $SHELL（校验可执行）→ zsh → bash → sh
 *
 * Windows 把 pwsh 排最前：Win PS 5.1 的 PSReadLine 在 ConPTY 下会把输入行重绘成
 * ANSI 黑底（ZCode 为此把 pwsh 提前的同一份取证）；powershell 在 System32 恒在，
 * 所以链条必有终点，探测永不失败。
 */
import { accessSync, constants } from "node:fs";
import { win32 } from "node:path";

/** Windows 回退链只在 win32 上跑，路径一律按 win32 规则拼——不随宿主平台的 node:path
 * （macOS 上跑单测时 posix join 会拼出 `C:\\Program Files/PowerShell/...` 的混合分隔符） */
const join = win32.join;

export interface ResolvedShell {
  /** 可执行文件的绝对路径（cmd 允许是 `cmd.exe` 裸名，交给 PATH 解析） */
  file: string;
  args: string[];
  /** tab / tooltip 上显示的短名（pwsh / powershell / cmd / bash …） */
  label: string;
}

export interface ShellResolverOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  canExecute?: (path: string) => boolean;
}

export function resolveTerminalShell(options: ShellResolverOptions = {}): ResolvedShell {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return resolveWindowsShell(options.env ?? process.env, options.canExecute ?? canExecute);
  return resolvePosixShell(platform, options.env ?? process.env, options.canExecute ?? canExecute);
}

function resolveWindowsShell(env: NodeJS.ProcessEnv, canExecute: (path: string) => boolean): ResolvedShell {
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  // pwsh 的两处常见落点：标准安装目录，以及 PATH 里的任何一份（scoop / winget 用户态安装）
  const pwshCandidates = [join(programFiles, "PowerShell", "7", "pwsh.exe"), ...pathCandidates(env, "pwsh.exe")];
  for (const candidate of pwshCandidates) {
    if (canExecute(candidate)) return { file: candidate, args: ["-NoLogo"], label: "pwsh" };
  }
  const powershell = join(
    env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (canExecute(powershell)) return { file: powershell, args: ["-NoLogo"], label: "powershell" };
  // cmd 是 Windows 上恒在的终点：ComSpec 缺席时裸名交给系统 PATH
  const comspec = env["ComSpec"] ?? "cmd.exe";
  return { file: comspec, args: [], label: "cmd" };
}

function resolvePosixShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  canExecute: (path: string) => boolean,
): ResolvedShell {
  // $SHELL 先过可执行校验：坏路径直接交给 posix_spawnp 只会换来一句含糊的报错
  const configured = env["SHELL"];
  if (configured !== undefined && configured !== "" && canExecute(configured)) {
    return { file: configured, args: ["-l"], label: tail(configured) };
  }
  const fallbacks = platform === "darwin" ? ["/bin/zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/bin/sh"];
  for (const candidate of fallbacks) {
    if (canExecute(candidate)) return { file: candidate, args: ["-l"], label: tail(candidate) };
  }
  throw new Error("找不到可用的 shell（$SHELL、zsh、bash、sh 都不可执行）");
}

/** 沿 PATH 找一个裸可执行名的所有候选（顺序即 PATH 顺序） */
function pathCandidates(env: NodeJS.ProcessEnv, name: string): string[] {
  const path = env["PATH"] ?? "";
  return path
    .split(/[;]/)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, name));
}

function tail(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
