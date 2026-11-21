/**
 * 本机 TeX 发行版的**宏包名表**（`\usepackage{…}` 的补全候选）。
 *
 * 数据来源是用户自己的 TeX 树，不搬任何第三方清单：
 *
 *   kpsewhich --show-path=tex     → 这台机器的 TeX 输入目录（TeX Live / MiKTeX 都带 kpsewhich）
 *   扫这些目录下的 *.sty          → 文件名去掉 .sty 就是 `\usepackage` 里写的名字
 *
 * **为什么不在仓里放一份包名表**：CTAN 的完整清单在 LaTeX-Workshop / TeXStudio 里是
 * GPL 派生物（见出包技能与旧调研），而且会给出一堆本机根本没装的包——用户选中一个
 * `\usepackage{foo}` 后编译才发现装不上。本机扫出来的名单天然与安装状态一致。
 *
 * 三个工程约束：
 * - **只在主进程做、只做一次**：走几万个文件不该发生在 renderer 的按键路径上；结果按
 *   latexmk 路径（= 同一套 TeX 树）缓存，换发行版后重新探测会换缓存键。
 * - **有上限**：名字数、扫描文件数、目录深度都封顶（shared 里的
 *   `LATEX_MAX_PACKAGE_NAMES` / `LATEX_MAX_PACKAGE_SCAN_FILES`），撞上就标 `truncated`。
 * - **失败安静**：没有 kpsewhich、扫不到目录、目录读不了，一律回
 *   `available:false` + 空名单——界面退回「只补已加载的 `\usepackage`」，不提示缺工具。
 *
 * 扫描本身走注入的 `readdir` / `run`（packages.ts 同一套做法）：单测用假目录树，
 * 不读真盘、不起进程。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir as readdirAsync } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import {
  LATEX_MAX_PACKAGE_NAMES,
  LATEX_MAX_PACKAGE_SCAN_FILES,
  type LatexPackageNamesOutcome,
} from "../../shared/latex.ts";

/** 目录深度上限：`tex/latex/<包名>/…` 一般 3 层，8 层足够且挡住异常目录 */
const SCAN_DEPTH = 8;

/** `kpsewhich --show-path=tex` 的等待上限：它只打印一行 */
const KPSEWHICH_TIMEOUT_MS = 15_000;

/** `\usepackage` 接受的包名形状；不合形状的文件名不进候选（也没法写进文档） */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export interface PackageNameEntry {
  name: string;
  directory: boolean;
}

export interface PackageNameRunResult {
  code: number | null;
  stdout: string;
  /** 起不来的原因（ENOENT …）；非 null 时 `code` 无意义 */
  spawnError: string | null;
}

export interface PackageNameDeps {
  run(command: string, argv: string[]): Promise<PackageNameRunResult>;
  /** 读目录；读不了回 null（权限 / 已删除） */
  readdir(dir: string): Promise<readonly PackageNameEntry[] | null>;
  exists(path: string): boolean;
  /** 环境变量 PATH 的分隔符（Windows `;`，其余 `:`）——kpsewhich 的输出按它拼 */
  pathDelimiter: string;
}

export interface LatexPackageNameIndex {
  /** 名字表；同一套 TeX 树只扫一次（并发调用共享同一个 Promise） */
  list(latexmk: string | null): Promise<LatexPackageNamesOutcome>;
}

const EMPTY: LatexPackageNamesOutcome = { available: false, names: [], truncated: false };

/**
 * `kpsewhich --show-path=tex` 的输出 → 目录列表。
 *
 * 每个条目可能带 `!!` 前缀（kpathsea 的「缓存过的」标记）和结尾的 `//`（递归标记）；
 * 两者都不是路径的一部分。空段（PATH 里常见的尾随分隔符）丢掉。
 */
export function parseTexSearchPath(stdout: string, pathDelimiter: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const part of stdout.split(pathDelimiter)) {
    const trimmed = part
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^!!/, "")
      .replace(/[\\/]+$/, "");
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(trimmed);
  }
  return dirs;
}

/** 目录树 → 排序去重的包名（注入的 readdir，单测用假树） */
export async function collectPackageNames(
  roots: readonly string[],
  deps: PackageNameDeps,
  limits: { names: number; files: number } = { names: LATEX_MAX_PACKAGE_NAMES, files: LATEX_MAX_PACKAGE_SCAN_FILES },
): Promise<{ names: string[]; truncated: boolean }> {
  const names = new Set<string>();
  const seenDirs = new Set<string>();
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  let files = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (names.size >= limits.names || files >= limits.files) {
      truncated = true;
      break;
    }
    const next = queue.shift();
    if (next === undefined) break;
    const key = next.dir.toLowerCase();
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    const entries = await deps.readdir(next.dir);
    if (entries === null) continue;
    for (const entry of entries) {
      files += 1;
      if (files > limits.files) {
        truncated = true;
        break;
      }
      if (entry.directory) {
        if (next.depth + 1 <= SCAN_DEPTH) queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
        continue;
      }
      if (!/\.sty$/i.test(entry.name)) continue;
      const name = entry.name.slice(0, -4);
      if (!PACKAGE_NAME.test(name)) continue;
      names.add(name);
      if (names.size >= limits.names) {
        truncated = true;
        break;
      }
    }
    if (files > limits.files) break;
  }

  return { names: [...names].sort(), truncated };
}

/** kpsewhich 的候选：先看 latexmk 同目录（发行版把整套命令装在一起），再交给 PATH */
function kpsewhichCandidates(latexmk: string | null): string[] {
  const out: string[] = [];
  if (latexmk !== null && (latexmk.includes("/") || latexmk.includes("\\"))) {
    const dir = dirname(latexmk);
    for (const name of ["kpsewhich.exe", "kpsewhich"]) out.push(join(dir, name));
  }
  out.push("kpsewhich");
  return out;
}

/**
 * 没有 kpsewhich 时的兜底：从 latexmk 的位置往上推发行版根，再猜几个常见的
 * `tex/latex` 目录。猜不到就回空数组（界面退回「只补已加载的」）。
 *
 * TeX Live（Windows）：`…/texlive/2025/bin/windows/latexmk.exe` → `…/texlive/2025/texmf-dist/tex/latex`
 * MiKTeX：`…/MiKTeX/bin/x64/latexmk.exe` → `…/MiKTeX/texmfs/install/tex/latex`
 */
function fallbackDirs(latexmk: string | null, deps: PackageNameDeps): string[] {
  if (latexmk === null || !(latexmk.includes("/") || latexmk.includes("\\"))) return [];
  const binDir = dirname(latexmk);
  const distroRoot = dirname(dirname(binDir));
  const upperRoot = dirname(distroRoot);
  const candidates = [
    join(distroRoot, "texmf-dist", "tex", "latex"),
    join(distroRoot, "texmf", "tex", "latex"),
    join(upperRoot, "texmf-dist", "tex", "latex"),
    join(distroRoot, "texmfs", "install", "tex", "latex"),
  ];
  const out: string[] = [];
  for (const dir of candidates) if (deps.exists(dir) && !out.includes(dir)) out.push(dir);
  return out;
}

/** 问 kpsewhich 要 TeX 输入目录；问不到就用兜底猜测 */
async function searchDirs(latexmk: string | null, deps: PackageNameDeps): Promise<string[]> {
  for (const binary of kpsewhichCandidates(latexmk)) {
    const result = await deps.run(binary, ["--show-path=tex"]);
    if (result.spawnError !== null || result.code !== 0 || result.stdout.trim() === "") continue;
    const dirs = parseTexSearchPath(result.stdout, deps.pathDelimiter).filter((dir) => deps.exists(dir));
    if (dirs.length > 0) return dirs;
  }
  return fallbackDirs(latexmk, deps);
}

export function createLatexPackageNameIndex(deps: PackageNameDeps = realDeps()): LatexPackageNameIndex {
  const cache = new Map<string, Promise<LatexPackageNamesOutcome>>();
  return {
    list(latexmk: string | null): Promise<LatexPackageNamesOutcome> {
      const key = latexmk ?? "";
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const pending = (async (): Promise<LatexPackageNamesOutcome> => {
        const dirs = await searchDirs(latexmk, deps);
        if (dirs.length === 0) return EMPTY;
        const { names, truncated } = await collectPackageNames(dirs, deps);
        return { available: names.length > 0, names, truncated };
      })().catch(() => EMPTY);
      cache.set(key, pending);
      return pending;
    },
  };
}

function runCommand(command: string, argv: string[]): Promise<PackageNameRunResult> {
  return new Promise((done) => {
    execFile(
      command,
      argv,
      { timeout: KPSEWHICH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
        if (error === null) {
          done({ code: 0, stdout: text, spawnError: null });
          return;
        }
        const raw = (error as { code?: unknown }).code;
        if (typeof raw === "number") {
          done({ code: raw, stdout: text, spawnError: null });
          return;
        }
        done({ code: null, stdout: text, spawnError: error.message });
      },
    );
  });
}

function realDeps(): PackageNameDeps {
  return {
    run: runCommand,
    async readdir(dir: string): Promise<readonly PackageNameEntry[] | null> {
      try {
        const entries = await readdirAsync(dir, { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
      } catch {
        return null;
      }
    },
    exists: existsSync,
    pathDelimiter: delimiter,
  };
}
