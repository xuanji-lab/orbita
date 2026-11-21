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
 * 2026-11「多文件导航」把上半句兑现了：闭包只回答「读过哪些文件」，导航要
 * 「谁包含谁 + 在哪一行」，所以同一个解析器再产出一张有向图（`buildIncludeGraph`）：
 * `file → includes[]`、反向 `owners[]`、它属于哪些 root，加上行号与参数列区间
 * （Ctrl+单击 判定用）。**不另写第二个解析器**：`includeClosure` 与图读同一份
 * `includeRefs`。
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

export const realIncludeDeps: IncludeDeps = {
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
  deps: IncludeDeps = realIncludeDeps,
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

  const rootText = readSourceText(deps, root);
  if (rootText === null) return null;
  add(root);

  /** 广度优先：逐层展开，深度与文件数都封顶 */
  let frontier = [root];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      const text = depth === 0 ? rootText : readSourceText(deps, file);
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

/** 读一份 .tex：超过上限 / 读不了时 null（不是错误，只是「看不见」） */
export function readSourceText(deps: IncludeDeps, path: string): string | null {
  const size = deps.size(path);
  if (size === null || size > MAX_FILE_BYTES) return null;
  try {
    return deps.read(path);
  } catch {
    return null;
  }
}

/** 一份 .tex 文本里的包含目标（绝对路径、已补齐扩展名、存在性未验） */
export function includesOf(text: string, baseDir: string, deps: IncludeDeps = realIncludeDeps): string[] {
  const found: string[] = [];
  /** 存在就用存在的那个；一个都不存在时记第一个候选（mtime 层会跳过它） */
  const push = (base: string, name: string, extensions: readonly string[]): void => {
    const candidates = candidatesOf(name, [base], extensions);
    const hit = candidates.find((candidate) => deps.exists(candidate));
    if (hit !== undefined) {
      found.push(hit);
      return;
    }
    const first = candidates[0];
    if (first !== undefined) found.push(first);
  };

  for (const ref of includeRefs(text)) push(baseDir, ref.raw, [".tex"]);
  // \import{dir}{file} / \subimport{dir}{file}：第一个参数是目录，相对当前文件
  const source = stripTexComments(text);
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

/**
 * 一条包含命令在源文件里的原样：命令名、参数原文、行号、参数的列区间（0 基、左闭右开）。
 *
 * **列区间是给 Ctrl/Cmd+单击 用的**：点中的位置落在这段里才算点了这个参数。
 * 由主进程算而不是让 renderer 再写一条正则：同一条命令只在一个地方被认得。
 */
export interface IncludeRef {
  /** 命令名，不带反斜杠（input / include / subfile / …） */
  command: string;
  /** 参数原文（已去首尾空白） */
  raw: string;
  /** 1 基行号 */
  line: number;
  /** 参数区（含花括号内两侧空白）在行内的起始列，0 基 */
  argFrom: number;
  /** 参数区的结束列，0 基、左闭右开 */
  argTo: number;
}

/** 认的包含命令。`subfileinclude` / `includestandalone` 与闭包那份同一套清单 */
const INCLUDE_COMMANDS =
  /\\(subfileinclude|includestandalone|input|include|subfile)\s*\{([^{}]+)\}/g;

/** 一份 .tex 里的包含命令（注释已剔除、保留行号与列） */
export function includeRefs(text: string): IncludeRef[] {
  const source = stripTexComments(text);
  const refs: IncludeRef[] = [];
  if (!source.includes("\\")) return refs;

  // 行起点表 + 二分：一个个 match 从头数行在长文档上是 O(n²)
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  /** 下标 → { 行号（1 基）, 该行起点 } */
  const lineAt = (index: number): { line: number; from: number } => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, from: lineStarts[low] ?? 0 };
  };

  for (const match of source.matchAll(INCLUDE_COMMANDS)) {
    const at = match.index ?? 0;
    const command = match[1] ?? "";
    const content = match[2] ?? "";
    const raw = content.trim();
    if (raw === "") continue;
    // 宏定义体里的 `\input{#1}` 是占位符，不是真路径（`candidatesOf` 也会拦下它）
    const { line, from } = lineAt(at);
    const argStart = at + match[0].length - 1 - content.length;
    refs.push({
      command,
      raw,
      line,
      argFrom: argStart - from,
      argTo: argStart - from + content.length,
    });
  }
  return refs;
}

/**
 * 一条包含参数的全部候选路径（按 bases 顺序 × 扩展名展开、去重）。
 *
 * 有扩展名的照它自己；没有的补 `.tex`（`\input{sec/ch1}` → `sec/ch1.tex`）。
 * 绝对路径不接在任何 base 后面——`\input{C:/x/y}` 就是它自己。
 * `#` 开头的参数是宏体占位符，直接没有候选。
 */
export function candidatesOf(
  name: string,
  bases: readonly string[],
  extensions: readonly string[] = [".tex"],
): string[] {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.includes("#")) return [];
  const expanded: string[] = [];
  const add = (path: string): void => {
    if (extname(path) === "") {
      for (const extension of extensions) expanded.push(`${path}${extension}`);
      return;
    }
    expanded.push(path);
  };
  if (isAbsolute(trimmed)) add(resolve(trimmed));
  else for (const base of bases) add(resolve(base, trimmed));
  // 三段基准常常重合（root 就在项目根、包含者也在根）：同一个候选只试一次
  return expanded.filter((path, index) => expanded.findIndex((other) => pathKey(other) === pathKey(path)) === index);
}

/**
 * 包含参数的解析：按 `bases` 的顺序找第一个**存在**的文件；一个都不存在回 null。
 *
 * **不瞎猜**：候选全落空就是 unresolved（调用方据此提示「找不到这个文件」），
 * 不退回「第一个候选」——那样会跳到一个不存在的路径上。闭包（mtime 层）才需要
 * 记下「没找到的那个路径」，它走 `candidatesOf` 自己取第一个。
 */
export function resolveInclude(
  name: string,
  bases: readonly string[],
  deps: IncludeDeps = realIncludeDeps,
): string | null {
  for (const candidate of candidatesOf(name, bases)) {
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

/** 图里的一条边：源文件的哪一行包含了谁 */
export interface IncludeEdge {
  command: string;
  raw: string;
  line: number;
  argFrom: number;
  argTo: number;
  /** 解析到的文件（绝对路径）；找不到为 null */
  target: string | null;
}

/** 图里的一个文件 */
export interface IncludeNode {
  /** 绝对路径 */
  path: string;
  /** 它包含谁（按出现顺序；unresolved 的 target 为 null） */
  includes: IncludeEdge[];
  /** 谁包含它（绝对路径、按发现顺序） */
  owners: string[];
  /** 它落在哪些 root 的闭包里（绝对路径） */
  roots: string[];
}

/** 撞上限的那一种，`at` 是撞上的那个文件 */
export type IncludeLimitKind = "depth" | "nodes" | "cycle";

export interface IncludeLimit {
  kind: IncludeLimitKind;
  at: string;
}

export interface IncludeGraph {
  /** 项目目录（第三段解析基准） */
  projectDir: string;
  /** 键 = `pathKey(path)`；值是文件本身 */
  nodes: Map<string, IncludeNode>;
  /** 撞过的上限（去重）；空数组 = 这张图是完整的 */
  limits: IncludeLimit[];
  /** 有上限被撞到（导航 / 大纲可能不全） */
  truncated: boolean;
}

/** 深度上限：main → part → chapter → section → subsection 已经是论文的极限，8 留足余量 */
export const INCLUDE_MAX_DEPTH = 8;

/** 文件数上限：单章一个文件的论文是几十份；2000 是「误指到别人的大仓」的刹车 */
export const INCLUDE_MAX_NODES = 2000;

/**
 * 从一组 root 出发建包含图（含 root 自己）。
 *
 * **路径解析顺序**：root 所在目录 → 包含者所在目录 → 项目目录。写 `\input{sec/ch1}`
 * 的项目大多按项目根写；`-cd` 编译（latexmk 在 root 目录跑）时第一段与第三段相同；
 * 只有 root 在子目录、包含者又在别处时三者才分开，那时 LaTeX 的真实规则取决于
 * 编译方式，我们取「先猜 root 目录」这一档并在文档里写明。
 *
 * 每条边只算一次（同一个文件被两个 root 包含时共用第一份边），所以两个 root 的
 * 目录不同时，后者的基准不参与解析——这是**已知的有意取舍**：真实论文的 root
 * 通常在同一层，为此把图按 root 复制一份不划算。
 *
 * 环（A→B→A）与深度 / 文件数上限都记进 `limits`，不静默：边仍然指向目标（它能
 * 点开、能标出类型），只是不再往下展开。
 */
export function buildIncludeGraph(
  projectDir: string,
  roots: readonly string[],
  deps: IncludeDeps = realIncludeDeps,
): IncludeGraph {
  const dir = resolve(projectDir);
  const nodes = new Map<string, IncludeNode>();
  const limits: IncludeLimit[] = [];
  let nodesCapped = false;

  const ensure = (path: string): IncludeNode | null => {
    const key = pathKey(path);
    const existing = nodes.get(key);
    if (existing !== undefined) return existing;
    if (nodes.size >= INCLUDE_MAX_NODES) {
      if (!nodesCapped) {
        nodesCapped = true;
        limits.push({ kind: "nodes", at: resolve(path) });
      }
      return null;
    }
    const node: IncludeNode = { path: resolve(path), includes: [], owners: [], roots: [] };
    nodes.set(key, node);
    return node;
  };

  const addRoot = (node: IncludeNode, rootPath: string): void => {
    const key = pathKey(rootPath);
    if (!node.roots.some((root) => pathKey(root) === key)) node.roots.push(rootPath);
  };

  /** 已经算过边的文件：图的边与「从哪个 root 出发」无关（见函数注释） */
  const expanded = new Set<string>();

  for (const root of roots) {
    const rootPath = resolve(root);
    const rootNode = ensure(rootPath);
    if (rootNode === null) break;
    addRoot(rootNode, rootPath);
    if (!deps.exists(rootPath)) continue;
    const rootDir = dirname(rootPath);

    const walk = (path: string, depth: number, stack: readonly string[]): void => {
      const node = ensure(path);
      if (node === null) return;
      addRoot(node, rootPath);
      const key = pathKey(path);
      if (expanded.has(key)) return;
      expanded.add(key);
      const text = readSourceText(deps, path);
      if (text === null) return;
      const bases = [rootDir, dirname(path), dir];
      node.includes = includeRefs(text).map((ref) => ({
        command: ref.command,
        raw: ref.raw,
        line: ref.line,
        argFrom: ref.argFrom,
        argTo: ref.argTo,
        target: resolveInclude(ref.raw, bases, deps),
      }));
      for (const edge of node.includes) {
        if (edge.target === null) continue;
        const child = ensure(edge.target);
        if (child === null) continue;
        if (!child.owners.some((owner) => pathKey(owner) === key)) child.owners.push(node.path);
        const childKey = pathKey(edge.target);
        if (stack.includes(childKey)) {
          limits.push({ kind: "cycle", at: edge.target });
          continue;
        }
        if (depth + 1 > INCLUDE_MAX_DEPTH) {
          limits.push({ kind: "depth", at: edge.target });
          continue;
        }
        walk(edge.target, depth + 1, [...stack, childKey]);
      }
    };

    walk(rootPath, 0, [pathKey(rootPath)]);
  }

  // 菱形包含会让同一个上限被撞两次：按 kind + 文件去重（界面只说「可能不全」）
  const unique = limits.filter(
    (limit, index) =>
      limits.findIndex((other) => other.kind === limit.kind && pathKey(other.at) === pathKey(limit.at)) === index,
  );
  return { projectDir: dir, nodes, limits: unique, truncated: unique.length > 0 };
}

/** 路径去重键（Windows 大小写不敏感）——包含图的节点键也用它 */
export function includeKey(path: string): string {
  return pathKey(path);
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
