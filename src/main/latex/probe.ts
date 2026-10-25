/**
 * latexmk 探测 —— 本机装没装、装在哪、能编哪几种引擎。
 *
 * 探测顺序（先便宜后昂贵，先用户配置后猜测）：
 *
 *   1. **显式路径**（设置里的 latexmk 路径；PR1 还没有这个设置键，接口先留好——
 *      probe(explicit) 已经有真实调用点：agent/设置页将来传入的那个值）
 *   2. **PATH**（TeX Live / MiKTeX 安装器通常已经加好）
 *   3. **常见根**：Windows 各盘的 `texlive\<年>\bin\windows` 与
 *      `%LOCALAPPDATA%\Programs\MiKTeX`；macOS 的 `/Library/TeX/texbin`、
 *      `/usr/local/texlive/<年>(basic)/bin/universal-darwin`、`/opt/homebrew/bin`；
 *      Linux 的 `/usr/local/texlive/<年>/bin/x86_64-linux`。
 *
 * 验活只有一个判据：`latexmk --version` 退出码 0（3 秒超时）。PATH 上有一个同名的
 * 坏文件、或者一个需要交互的壳脚本，都会在这里被挡掉——否则它会等到编译超时才暴露。
 *
 * 结果按进程缓存（一次编译会探测两次：开编前与界面探活）。安装 / 换发行版之后
 * 由 `refresh()` 显式作废——没有 stdout 监听、没有 watch，别让一个后台 stat 循环
 * 跟着应用跑一整天。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import { LATEX_ENGINES, type LatexEngine, type LatexProbeResult } from "../../shared/latex.ts";

/** `latexmk --version` 的等待上限。TeX Live 的 Perl 启动在本机实测 0.2–0.8 秒 */
const VERSION_TIMEOUT_MS = 3000;

export interface LatexProbeDeps {
  platform: NodeJS.Platform;
  /** PATH 等环境变量（大小写按平台处理：Windows 上常见的是 `Path`） */
  env: Record<string, string | undefined>;
  /**
   * 路径算法。**随 deps.platform 注入而不是用进程的 node:path**：探测做的全是
   * 平台相关路径（`texlive\2024\bin\windows` vs `/usr/local/texlive/...`），
   * 测试要能在任何宿主上跑 macOS / Linux 的发现逻辑（Windows 上的 dirname 会把
   * posix 路径当反斜杠路径处理）。生产默认按 process.platform 选一份。
   */
  path: LatexPathApi;
  /** 文件存在性；测试可注入 */
  exists(path: string): boolean;
  /** 列目录（失败回空）；测试可注入 */
  list(dir: string): string[];
  /** 跑 `<command> --version`：退出码 0 回 stdout，否则 null。测试注入假货，不真起 latexmk */
  version(command: string): Promise<string | null>;
}

export interface LatexPathApi {
  join(...parts: string[]): string;
  dirname(path: string): string;
  /** PATH 分隔符 */
  delimiter: string;
}

/** 探测结果缓存 + 显式作废 */
export interface LatexProbe {
  /** explicit = 设置里指定的路径；同一进程里 PATH/常见根的结果缓存复用 */
  probe(explicit?: string): Promise<LatexProbeResult>;
  refresh(): void;
}

export function createLatexProbe(deps: LatexProbeDeps = realDeps()): LatexProbe {
  let cached: LatexProbeResult | null = null;
  return {
    async probe(explicit?: string): Promise<LatexProbeResult> {
      // 显式路径每次都现验：用户刚在设置里改完，不该等一次重启才生效
      if (explicit === undefined && cached !== null) return cached;
      const result = await probeOnce(deps, explicit);
      if (explicit === undefined) cached = result;
      return result;
    },
    refresh(): void {
      cached = null;
    },
  };
}

async function probeOnce(deps: LatexProbeDeps, explicit: string | undefined): Promise<LatexProbeResult> {
  if (explicit !== undefined && explicit.trim() !== "") {
    const candidate = explicit.trim();
    const version = deps.exists(candidate) ? await deps.version(candidate) : null;
    if (version !== null) return found(deps, candidate, version, "setting");
    console.warn(`[latex] 设置里的 latexmk 路径不可用：${candidate}，改从 PATH 与常见安装位置找`);
  }

  for (const dir of pathDirs(deps)) {
    const candidate = firstExisting(deps, dir, executableNames(deps.platform, "latexmk"));
    if (candidate === null) continue;
    const version = await deps.version(candidate);
    if (version !== null) return found(deps, candidate, version, "path");
  }

  for (const dir of commonRoots(deps)) {
    const candidate = firstExisting(deps, dir, executableNames(deps.platform, "latexmk"));
    if (candidate === null) continue;
    const version = await deps.version(candidate);
    if (version !== null) return found(deps, candidate, version, "common");
  }

  return {
    ok: false,
    latexmk: null,
    version: null,
    engines: [],
    source: null,
    message:
      "latexmk was not found. Install TeX Live (Windows: https://tug.org/texlive/, macOS: MacTeX) " +
      "or MiKTeX, then retry.",
  };
}

function found(deps: LatexProbeDeps, latexmk: string, output: string, source: LatexProbeResult["source"]): LatexProbeResult {
  return {
    ok: true,
    latexmk,
    version: versionLine(output),
    // 可用引擎 = 与 latexmk 同目录（PATH 命中时再扫一遍 PATH）里真有那个可执行文件。
    // 不逐个跑 --version：三个引擎各起一次 Perl 是白等，而缺引擎时 latexmk 自己会报
    // "Rule 'xelatex' not found"，那条错比探测时的猜测更准确。
    engines: detectEngines(deps, latexmk),
    source,
    message: "",
  };
}

/** 版本行：latexmk 的 stdout 前面可能带终端代码页提示（Windows CP936），找含 Version 的那行 */
function versionLine(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const withVersion = lines.find((line) => /version/i.test(line));
  return withVersion ?? lines[0] ?? null;
}

/** 一个引擎的可执行文件名（跟平台走） */
function executableNames(platform: NodeJS.Platform, base: string): string[] {
  return platform === "win32"
    ? [`${base}.exe`, `${base}.bat`, `${base}.cmd`, base]
    : [base];
}

function firstExisting(deps: LatexProbeDeps, dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const path = deps.path.join(dir, name);
    if (deps.exists(path)) return path;
  }
  return null;
}

/** PATH 各段。Windows 上变量名大小写不定（`Path` / `PATH` / `path`），按原名找 */
function pathDirs(deps: LatexProbeDeps): string[] {
  const key =
    deps.platform === "win32"
      ? Object.keys(deps.env).find((name) => name.toUpperCase() === "PATH")
      : "PATH";
  const value = key === undefined ? undefined : deps.env[key];
  if (value === undefined || value === "") return [];
  return value
    .split(deps.path.delimiter)
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter((part) => part !== "");
}

/**
 * 常见安装根里「含 latexmk 的 bin 目录」。
 * 先列出这些根本身（它们就是 bin 目录），再展开 texlive 的年份子目录。
 */
function commonRoots(deps: LatexProbeDeps): string[] {
  if (deps.platform === "win32") return windowsRoots(deps);
  if (deps.platform === "darwin") return macRoots(deps);
  return linuxRoots(deps);
}

function windowsRoots(deps: LatexProbeDeps): string[] {
  const roots: string[] = [];
  // TeX Live：各盘的 texlive\<年>\bin\windows。A/B 是软驱位，从 C 起
  for (const drive of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const texlive = `${drive}:\\texlive`;
    for (const year of yearDirs(deps, texlive)) {
      roots.push(deps.path.join(texlive, year, "bin", "windows"));
    }
  }
  // MiKTeX：安装器默认落在 LOCALAPPDATA（用户级）或 Program Files（系统级）
  const local = deps.env["LOCALAPPDATA"];
  if (local !== undefined && local !== "") {
    roots.push(deps.path.join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"));
    roots.push(deps.path.join(local, "Programs", "MiKTeX"));
  }
  for (const key of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const base = deps.env[key];
    if (base !== undefined && base !== "") roots.push(deps.path.join(base, "MiKTeX", "miktex", "bin", "x64"));
  }
  return roots;
}

function macRoots(deps: LatexProbeDeps): string[] {
  const roots = ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin"];
  // 完整安装是 texlive/2024/…，BasicTeX 是 texlive/2024basic/…（yearDirs 两种都认）
  const texlive = "/usr/local/texlive";
  for (const year of yearDirs(deps, texlive)) {
    roots.push(deps.path.join(texlive, year, "bin", "universal-darwin"));
  }
  return roots;
}

function linuxRoots(deps: LatexProbeDeps): string[] {
  const roots = ["/usr/bin", "/usr/local/bin"];
  const texlive = "/usr/local/texlive";
  for (const year of yearDirs(deps, texlive)) {
    roots.push(deps.path.join(texlive, year, "bin", "x86_64-linux"));
  }
  return roots;
}

/** texlive 根下的年份目录（"2024" / "2023basic"），按名字倒序让新年份优先 */
function yearDirs(deps: LatexProbeDeps, texlive: string): string[] {
  if (!deps.exists(texlive)) return [];
  return deps
    .list(texlive)
    .filter((name) => /^\d{4}(?:basic)?$/.test(name))
    .sort()
    .reverse();
}

/** 找与 latexmk 同目录的引擎；PATH 上的 latexmk 再从 PATH 找一遍 */
function detectEngines(deps: LatexProbeDeps, latexmk: string): LatexEngine[] {
  const dirs = [deps.path.dirname(latexmk), ...pathDirs(deps)];
  return LATEX_ENGINES.filter((engine) => {
    const binary = engine === "pdf" ? "pdflatex" : engine;
    return dirs.some((dir) => firstExisting(deps, dir, executableNames(deps.platform, binary)) !== null);
  });
}

function realDeps(): LatexProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    path: process.platform === "win32" ? win32 : posix,
    exists: (path) => existsSync(path),
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    version: (command) => runVersion(command),
  };
}

/**
 * `latexmk --version`。**不带 shell**：参数表是固定的，起一个 shell 只是多一层。
 * Windows 上 `.bat` / `.cmd` 需要 shell 才能执行——TeX Live 与 MiKTeX 给的都是
 * `.exe`，所以这里不做特殊处理；真遇到 `.cmd` 的发行版，探测会回 not-installed，
 * 用户仍可以用设置里的显式路径 + 自备包装脚本绕过。
 */
function runVersion(command: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolvePromise(null);
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}
