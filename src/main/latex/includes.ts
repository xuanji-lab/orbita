/**
 * 一份 root 的 include 闭包 —— 「改哪些文件会让这份 root 的 PDF 过期」。
 *
 * 为什么需要它：`sourceModifiedAt` 原先是**整个项目**一个值（project.ts 递归扫
 * .tex/.bib/.cls/.sty），多 root 时就变成「改附录让正文变脏」。闭包把判定收回到
 * 「这份 root 真的读哪些文件」。
 *
 * 只做**路径层**的解析（不建 AST）：论文项目的包含就是 \input / \include / \subfile /
 * \import 这几种，注释剔除后一条正则足够；上 AST 的成本要等「\input 点击跳转 /
 * 大纲跨文件」真需要时再付——那时这张图就是它们要读的那张，不是为多 root 专门造的抽象。
 *
 * 上限（深度 4 / 文件 200 / 单文件 2 MB）**只防病态仓，不静默**：撞上限置
 * `truncated`，调用方退回项目级判定，宁可多报一次「脏」，也不漏掉一次该编的改动。
 *
 * subfiles 的单章编译（`\documentclass[../main.tex]{subfiles}`）这一轮不做，但闭包
 * 已经认 `\subfile`：root 模型不挡它——单章自己的 root 就是那份 .tex，闭包只跟它
 * 包含的文件，不会把整本拖进来。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { stripTexComments } from "./index.ts";

export interface IncludeClosure {
  /** 闭包里的文件（绝对路径、去重、已 resolve；不保证都存在） */
  files: string[];
  /** 撞到深度 / 文件数 / 体积上限：闭包可能不全 */
  truncated: boolean;
}

/** 文件数上限：真实论文的闭包在几十份量级；200 给到「一章一个文件 + 图片不用管」 */
const MAX_FILES = 200;

/** 深度上限：main → part → chapter → section 已经是论文的极限 */
const MAX_DEPTH = 4;

/** 单文件读取上限：超过这个长度的 .tex 多半不是源码（日志 / 转义过的数据） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IncludeDeps {
  read(path: string): string;
  exists(path: string): boolean;
  size(path: string): number | null;
}

const realFs: IncludeDeps = {
  read: (path) => readFileSync(path, "utf8"),
  exists: (path) => existsSync(path),
  size: (path) => {
    try {
      const stats = statSync(path);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  },
};

/**
 * 从 `rootPath` 出发的 include 闭包（含 root 自己）。
 *
 * 读不了 root（不存在 / 没权限）时回 **null**：调用方必须退回项目级 mtime，
 * 「读不到」不等于「没有包含」。
 */
export function includeClosure(
  rootPath: string,
  deps: IncludeDeps = realFs,
): IncludeClosure | null {
  const root = resolve(rootPath);
  const files: string[] = [];
  const seen = new Map<string, true>();
  let truncated = false;

  const add = (path: string): boolean => {
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.set(key, true);
    files.push(path);
    if (files.length >= MAX_FILES) {
      truncated = true;
      return false;
    }
    return true;
  };

  const rootText = readText(deps, root);
  if (rootText === null) return null;
  add(root);

  /** 广度优先：逐层展开，深度与文件数都封顶 */
  let frontier = [root];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      const text = depth === 0 ? rootText : readText(deps, file);
      if (text === null) continue;
      for (const target of includesOf(text, dirname(file), deps)) {
        if (!add(target)) continue;
        next.push(target);
      }
      if (files.length >= MAX_FILES) break;
    }
    frontier = next;
  }
  return { files, truncated };
}

function readText(deps: IncludeDeps, path: string): string | null {
  const size = deps.size(path);
  if (size === null || size > MAX_FILE_BYTES) return null;
  try {
    return deps.read(path);
  } catch {
    return null;
  }
}

/** 一份 .tex 文本里的包含目标（绝对路径、已补齐扩展名、存在性未验） */
export function includesOf(text: string, baseDir: string, deps: IncludeDeps = realFs): string[] {
  const source = stripTexComments(text);
  const found: string[] = [];
  const push = (base: string, name: string, extensions: readonly string[]): void => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.includes("#")) return;
    const start = isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed);
    // 有扩展名的照它自己；没有的按常见扩展名试（\input{x} → x.tex）
    const candidates = extname(start) === "" ? extensions.map((ext) => `${start}${ext}`) : [start];
    for (const candidate of candidates) {
      if (deps.exists(candidate)) {
        found.push(candidate);
        return;
      }
    }
    found.push(candidates[0] ?? start);
  };

  for (const match of source.matchAll(/\\(?:input|include|subfile|subfileinclude|includestandalone)\s*\{([^{}]+)\}/g)) {
    push(baseDir, match[1] ?? "", [".tex"]);
  }
  // \import{dir}{file} / \subimport{dir}{file}：第一个参数是目录，相对当前文件
  for (const match of source.matchAll(/\\(?:sub)?import\*?\s*\{([^{}]*)\}\s*\{([^{}]+)\}/g)) {
    const sub = (match[1] ?? "").trim();
    const base = sub === "" ? baseDir : isAbsolute(sub) ? sub : resolve(baseDir, sub);
    push(base, match[2] ?? "", [".tex"]);
  }
  // 文献库：.bib 的改动同样让 PDF 过期
  for (const match of source.matchAll(/\\(?:bibliography|addbibresource)\s*\{([^{}]+)\}/g)) {
    for (const name of (match[1] ?? "").split(",")) push(baseDir, name, [".bib"]);
  }
  return found;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 闭包里的最新 mtime；一个都 stat 不到时 null（调用方退回项目级） */
export function newestInClosure(closure: IncludeClosure): number | null {
  let newest: number | null = null;
  for (const path of closure.files) {
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      newest = newest === null ? stats.mtimeMs : Math.max(newest, stats.mtimeMs);
    } catch {
      // 闭包里记着但文件被删：跳过
    }
  }
  return newest;
}

/** 闭包是否包含某个文件（focusedRoot 的判据；两侧都按 resolve 后的路径比） */
export function closureContains(closure: IncludeClosure, path: string): boolean {
  const key = pathKey(path);
  return closure.files.some((file) => pathKey(file) === key);
}
