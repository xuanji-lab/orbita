/**
 * PTY 的环境与工作目录 —— spawn 前的最后一步装配。**纯模块**，可注入可测。
 *
 * 取证来源是 ZCode 的 `resolveTerminalEnv`（注释存档在调研笔记）：GUI 启动的
 * Electron 常带着过窄的 PATH 与 C/POSIX locale——前者让 macOS 上 npm/node 找不到，
 * 后者让中文路径在 zsh 里显示成 `\M-^` 转义乱码。都在「传给 PTY 的这份 env 副本」里
 * 补，不改全局 `process.env`。
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

export interface TerminalEnvOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function resolveTerminalEnv(options: TerminalEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const next: NodeJS.ProcessEnv = { ...env };

  // macOS 从 Dock / Finder 启动时 PATH 往往只有 /usr/bin:/bin 一类：在终端自己的
  // env 里补 Homebrew 与系统路径，保留用户已有顺序（Windows / Linux 不动）
  if (platform === "darwin") next["PATH"] = resolveDarwinPath(env);

  // 真终端必须以交互终端的能力声明启动：starship / p10k / 颜色检测靠这两项判断，
  // 缺了会整体降级成无样式输出
  next["TERM"] = "xterm-256color";
  const colorTerm = next["COLORTERM"]?.trim();
  if (colorTerm === undefined || colorTerm === "") next["COLORTERM"] = "truecolor";
  // 登录 shell 环境采集类工具会用 CI=1 + TERM=dumb 采样；真终端里 CI 必须摘掉
  if (next["CI"] === "1" && env["TERM"] === "dumb") delete next["CI"];

  // locale 缺失或明确是 C / POSIX 时补 UTF-8：用户配好的 locale 原样保留
  const fallback = fallbackUtf8Locale(platform, env);
  if (isMissingOrC(next["LANG"])) next["LANG"] = fallback;
  if (isMissingOrC(next["LC_CTYPE"])) next["LC_CTYPE"] = fallback;
  if (next["LC_ALL"] !== undefined && isMissingOrC(next["LC_ALL"])) next["LC_ALL"] = fallback;
  return next;
}

/**
 * cwd 的回退链：传入目录还在就用它；失效（被挪走 / 删掉）回退 homedir，**不报错**
 * ——人工终端允许「目录没了再开一次」。返回值保证是一个现存目录。
 */
export function resolveTerminalCwd(cwd: string | undefined): string {
  if (cwd !== undefined && isDirectory(cwd)) return cwd;
  return homedir();
}

function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fallbackUtf8Locale(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  // 用户任意一处已经配了 UTF-8 locale 就沿用（顺序即优先级，同 libc 的查找顺序）
  const inherited = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]].find(
    (value) => typeof value === "string" && /utf-?8/i.test(value),
  );
  if (inherited !== undefined) return inherited;
  return platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

function isMissingOrC(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "C" || trimmed === "POSIX";
}

function resolveDarwinPath(env: NodeJS.ProcessEnv): string {
  const additions = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];
  const current = env["PATH"] ?? "";
  const existing = current.split(":").filter((dir) => dir !== "");
  const merged = [...existing];
  for (const dir of additions) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  return merged.join(":");
}
