/**
 * 「这个文件属于哪个 LaTeX 项目」—— 编译条的第一问，也是 renderer 唯一能拿到的
 * 项目描述（`latex:project`）。
 *
 * 项目目录 = 从文件所在目录往上找到的**最近一个** LaTeX 项目：
 *   - 有 `.orbita/latex.json`（用户显式指定过引擎 / 主文件），或
 *   - ≤2 层里有带 `\documentclass` 的 .tex（原型裁决：不是「目录里有 .tex 就算」——
 *     很多仓库的 docs/ 里躺着零散片段，编译条不该在那里出现）。
 * 往上找到文件面板的根为止：不越出白名单，也不把上层仓库误认成项目。
 *
 * 只读盘、不起进程：`latexmk` 的探测在 probe.ts，编译在 run.ts。这里给界面的是
 * 「有几个可编译的根、下一次编哪一份、产物是不是比源码旧」几件事的事实。
 *
 * **多个根**（2026-11 起）：`roots[]` 是递归发现 + 配置里的全部候选；
 * `activeRoot` 是「下一次编译会用的那一份」。脏判定按**每个 root 的 include 闭包**
 * （includes.ts）算——改附录不再让正文变脏。
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  LATEX_CONFIG_PATH,
  type LatexEngine,
  type LatexProjectInfo,
  type LatexRootConfig,
  type LatexRootInfo,
} from "../../shared/latex.ts";
import { writeJsonAtomic } from "../atomic-write.ts";
import { samePath } from "../../shared/path.ts";
import {
  detectEngine,
  discoverRoots,
  normalizeProjectConfig,
  parseProjectConfig,
  resolveLatexPlan,
  type LatexPlan,
  type LatexProjectConfig,
} from "./resolve.ts";
import { closureContains, includeClosure, newestInClosure } from "./includes.ts";

/** 项目探测里算「源码」的扩展名：改这些会让 PDF 过期 */
const SOURCE_EXTS = new Set([".tex", ".bib", ".cls", ".sty"]);

/** 递归扫源码时跳过的目录名（隐藏目录另判）：产物、依赖、版本库 */
const SKIP_DIRS = new Set(["node_modules", "build", "out", "dist", ".git", ".svn"]);

/** 递归上限：论文项目的源码一般两三层，再深多半是误入别人的仓库 */
const MAX_DEPTH = 3;

/** 每个目录最多收的条目：防止在一个巨大的目录里把面板拖死 */
const MAX_ENTRIES = 500;

/** 判断一份 .tex 是不是文档根时只读头部这么多字节——\documentclass 总在导言区 */
const HEAD_BYTES = 8 * 1024;

/** focusedRoot 最多为几个 root 建闭包：再多就不猜了（面板高亮不是关键路径） */
const FOCUS_MAX_ROOTS = 12;

/** 文件所在目录 → 项目目录；找不到回 null。`boundary` 是白名单根（含） */
export function findLatexProjectDir(filePath: string, boundary: string): string | null {
  const start = resolve(filePath);
  const stop = resolve(boundary);
  let dir: string;
  try {
    dir = statSync(start).isDirectory() ? start : dirname(start);
  } catch {
    dir = dirname(start);
  }
  while (true) {
    if (looksLikeLatexProject(dir)) return dir;
    if (samePath(dir, stop)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    // 不越出白名单根：上层目录就算有 .tex，也不归这条授权管
    const rel = relative(stop, parent);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    dir = parent;
  }
}

/** 显式配置，或 ≤2 层里真有 `\documentclass` 的 .tex */
function looksLikeLatexProject(dir: string): boolean {
  if (existsSync(join(dir, LATEX_CONFIG_PATH))) return true;
  return hasRootDocument(dir, 0);
}

/**
 * ≤2 层里有没有文档根。**不用 discoverRoots**：它会在「一个都没有」时退回顶层
 * .tex（给界面当候选），那样「docs/ 里几个零散 .tex」就会被当成项目。
 */
function hasRootDocument(dir: string, depth: number): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth >= 2 || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      subdirs.push(path);
      continue;
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".tex") continue;
    if (hasDocumentClass(path)) return true;
  }
  return subdirs.some((path) => hasRootDocument(path, depth + 1));
}

function topLevelTex(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => extname(name).toLowerCase() === ".tex" && !name.startsWith("."))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function hasDocumentClass(path: string): boolean {
  try {
    return /\\documentclass\b/.test(readFileSync(path, "utf8").slice(0, HEAD_BYTES));
  } catch {
    return false;
  }
}

function readConfig(dir: string): LatexProjectConfig {
  try {
    return parseProjectConfig(JSON.parse(readFileSync(join(dir, LATEX_CONFIG_PATH), "utf8")) as unknown);
  } catch {
    return { roots: [] };
  }
}

/** 原始 JSON（写回时用它做归一化；解析失败当空配置） */
function readRawConfig(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, LATEX_CONFIG_PATH), "utf8")) as unknown;
  } catch {
    return {};
  }
}

export interface DescribeLatexProjectOptions {
  /** 当前打开 / 刚编辑的文件（绝对路径）：它的 `% !TEX root` 决定 activeRoot，也用来算 focusedRoot */
  file?: string;
  /** 授权根（文件面板白名单根）。magic 越界时返回 root-outside-workspace 的 detail */
  boundary?: readonly string[];
}

/**
 * 项目描述。根解析复用 `resolveLatexPlan`——编译条看到的「会用哪个主文件、哪个
 * 引擎、哪个产物目录」必须就是编译时真正用的那一个，不能在这里另写一份优先级。
 */
export function describeLatexProject(
  projectDir: string,
  options: DescribeLatexProjectOptions = {},
): LatexProjectInfo {
  const dir = resolve(projectDir);
  const config = readConfig(dir);
  const plan = resolveLatexPlan(
    dir,
    {
      ...(options.file === undefined ? {} : { file: options.file }),
      ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
    },
    // 不传 deps：describe 只走真盘（deps 注入点是给 resolve 的单测用的）
  );

  /** 候选路径：配置里写过的 ∪ 递归发现的（含 root 在子目录的情况） */
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (path: string): void => {
    const key = pathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(path);
  };
  for (const path of config.roots.map((root) => root.path)) addCandidate(path);
  if (config.activeRoot !== undefined) addCandidate(config.activeRoot);
  if (config.main !== undefined) addCandidate(config.main);
  for (const path of discoverRoots(dir)) addCandidate(path);
  const activePath = plan.status === "ok" ? plan.root.path : null;
  if (activePath !== null) addCandidate(activePath);

  /** 每个 root 的闭包：只在算 focusedRoot（给了 file）时建；否则只为 active root 建 */
  const closures = new Map<string, ReturnType<typeof includeClosure>>();
  const closureOf = (rootPath: string): ReturnType<typeof includeClosure> => {
    const key = pathKey(rootPath);
    const cached = closures.get(key);
    if (cached !== undefined) return cached;
    const closure = includeClosure(resolve(dir, rootPath));
    closures.set(key, closure);
    return closure;
  };
  const needsAllClosures = options.file !== undefined && candidates.length <= FOCUS_MAX_ROOTS;

  let projectLevelSource: number | null | undefined;
  const projectSource = (): number | null => {
    if (projectLevelSource === undefined) projectLevelSource = newestSource(null, dir);
    return projectLevelSource;
  };
  /** 一个 root 的脏判定输入：闭包算不出来 / 撞上限时退回项目级（注释见下） */
  const sourceOf = (rootPath: string): number | null => {
    if (!needsAllClosures && activePath !== null && pathKey(activePath) !== pathKey(rootPath)) {
      // 非激活 root 不参与过期判定：每 4 秒为每个 root 建一次闭包是白读盘。
      // 需要时（界面显示每个 root 的状态）再打开。
      return null;
    }
    const closure = closureOf(rootPath);
    if (closure === null || closure.truncated) {
      // 闭包算不出来（root 读不到）或撞上限（可能漏文件）：退回项目级。
      // 宁可多报一次「脏」，也不漏掉一次该编的改动——这一档是安全侧。
      return projectSource();
    }
    return newestInClosure(closure);
  };

  const roots: LatexRootInfo[] = [];
  for (const path of candidates) {
    const planForRoot = resolveLatexPlan(
      dir,
      { main: path, ...(options.boundary === undefined ? {} : { boundary: options.boundary }) },
    );
    if (planForRoot.status !== "ok") continue; // 候选被删 / 配置指错：不出现在 roots[] 里
    const isActive = activePath !== null && pathKey(activePath) === pathKey(planForRoot.root.path);
    const root: LatexRootInfo = isActive
      ? {
          ...planForRoot.root,
          pdf: locateRootPdf(planForRoot),
          sourceModifiedAt: sourceOf(planForRoot.root.path),
          detail: null,
        }
      : {
          ...planForRoot.root,
          // 非激活 root 的「怎么被发现的」按配置 / 扫描归类：request 只属于这一次调用，
          // 写进 roots[] 会让界面以为用户手点了它
          source: sourceForCandidate(config, planForRoot.root.path),
          declaredBy: null,
          pdf: locateRootPdf(planForRoot),
          sourceModifiedAt: sourceOf(planForRoot.root.path),
          detail: null,
        };
    roots.push(root);
  }

  const active = roots.find((root) => pathKey(root.path) === pathKey(activePath ?? "")) ?? null;
  const mains = roots.length > 0 ? roots.map((root) => root.path) : topLevelTex(dir);
  const engine: LatexEngine = plan.status === "ok"
    ? plan.engine
    : (config.engine ?? autoEngineOf(dir, mains));
  const engineSource: LatexProjectInfo["engineSource"] = plan.status === "ok"
    ? plan.engineSource
    : (config.engine === undefined ? "auto" : "config");

  const focusedRoot = options.file === undefined ? null : focusedRootOf(options.file, roots, closureOf);
  const rootConfig = plan.status === "ok" ? plan.rootConfig : {};

  return {
    dir: plan.status === "ok" ? plan.dir : dir,
    roots,
    activeRoot: activePath,
    focusedRoot,
    engine,
    engineSource,
    main: plan.status === "ok" ? plan.mainName : null,
    mains,
    configured: {
      ...(config.main === undefined ? {} : { main: config.main }),
      ...(config.engine === undefined ? {} : { engine: config.engine }),
      ...(config.activeRoot === undefined ? {} : { activeRoot: config.activeRoot }),
      ...(rootConfig.outDir === undefined ? {} : { outDir: rootConfig.outDir }),
      ...(rootConfig.recipe === undefined ? {} : { recipe: rootConfig.recipe }),
    },
    pdf: active?.pdf === undefined || active.pdf === null ? null : { path: active.pdf.path, modifiedAt: active.pdf.modifiedAt },
    sourceModifiedAt: active?.sourceModifiedAt ?? null,
    detail: plan.status === "ok" ? null : plan.detail,
    // 明确写 false 的也是关（与缺席同一个行为），界面只需要一个是非值
    compileOnSave: config.compileOnSave === true,
  };
}

/** 非激活 root 的来源归类：配置里写过的算 config / active，其余是扫描发现的 */
function sourceForCandidate(
  config: LatexProjectConfig,
  path: string,
): LatexRootInfo["source"] {
  const key = pathKey(path);
  if (config.activeRoot !== undefined && pathKey(config.activeRoot) === key) return "active";
  if (config.roots.some((root) => pathKey(root.path) === key)) return "config";
  if (config.main !== undefined && pathKey(config.main) === key) return "config";
  return "scan";
}

/** 当前文件落在哪个 root 的闭包里；恰好一个时返回它，否则 null（不猜） */
function focusedRootOf(
  file: string,
  roots: readonly LatexRootInfo[],
  closureOf: (rootPath: string) => ReturnType<typeof includeClosure>,
): string | null {
  const hits: string[] = [];
  for (const root of roots) {
    const closure = closureOf(root.path);
    if (closure === null) continue;
    if (closureContains(closure, file)) hits.push(root.path);
  }
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** 没有主文件时的引擎猜测：读第一个候选的正文（与编译时的 detectEngine 同一规则） */
function autoEngineOf(dir: string, mains: readonly string[]): LatexEngine {
  const first = mains[0];
  if (first === undefined) return "pdf";
  try {
    return detectEngine(readFileSync(join(dir, first), "utf8"));
  } catch {
    return "pdf";
  }
}

/**
 * 产物位置不假定叫 `<main>.pdf`：`-jobname` 会把名字换掉，自定义 recipe 可以不带
 * -outdir（产物落在主文件旁边）。顺序与 run.ts 的 locatePdf 同源：
 * 先按 jobname / basename 在 outDir 找，再在主文件目录找。
 */
function locateRootPdf(plan: LatexPlan): LatexRootInfo["pdf"] {
  const name = plan.jobname ?? basename(plan.mainName, extname(plan.mainName));
  for (const candidate of [join(plan.outDir, `${name}.pdf`), join(dirname(plan.mainPath), `${name}.pdf`)]) {
    try {
      const stats = statSync(candidate);
      if (stats.isFile()) return { path: candidate, modifiedAt: stats.mtimeMs, pages: null };
    } catch {
      // 没编过 / 被删：继续找下一个候选
    }
  }
  return null;
}

/**
 * 最新源码 mtime：主文件 + 项目内（≤ 3 层）的 .tex/.bib/.cls/.sty。产物目录
 * （build/）按 SKIP_DIRS 跳过——那里除了 PDF 还有 .aux/.log，它们跟着编译变，
 * 算进源码会让「过期」永远为真。
 *
 * **只在闭包算不出来时用**（fallback）：它是整个项目的值，多 root 时会串脏
 * （改附录让正文变脏）——闭包（includes.ts）才是常规路径。
 */
function newestSource(mainPath: string | null, projectDir: string): number | null {
  let newest: number | null = null;
  const note = (path: string): void => {
    try {
      const stats = statSync(path);
      if (!stats.isFile()) return;
      newest = newest === null ? stats.mtimeMs : Math.max(newest, stats.mtimeMs);
    } catch {
      // 扫描与 stat 之间文件被删：跳过
    }
  };
  if (mainPath !== null) note(mainPath);

  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= MAX_ENTRIES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTS.has(extname(entry.name).toLowerCase())) continue;
      seen += 1;
      note(path);
    }
  };
  walk(projectDir, 0);
  return newest;
}

/** 写配置的入参（IPC 层已经把 unknown 挡在类型外；这里再验一遍值） */
export interface LatexConfigPatch {
  /** 设为 activeRoot */
  activate?: string;
  /** 新增 / 更新一个 root 的配置；path 必填 */
  root?: { path: string } & Partial<Omit<LatexRootConfig, "path">>;
  /** 只删配置，不删文件 */
  removeRoot?: string;
  /** v1 兼容：等价于 activate + 为它建一条 root */
  main?: string;
  /** 写到**当前生效的 root** 上（v2 的 engine 是 per-root 的） */
  engine?: LatexEngine;
  compileOnSave?: boolean;
}

/**
 * 把 root / 引擎的选择写进项目 `.orbita/latex.json`（原子写，v2 形状）。
 *
 * **合并而不是覆盖**：用户手写的 outDir / args / recipe 不能被一次 chip 点击抹掉。
 * 读进来先 `normalizeProjectConfig`（v1 的 main/outDir/args/recipe 迁移到 roots[]），
 * 写回只产出 `{ version: 2, activeRoot, roots, compileOnSave }`——`main` 不再产出。
 *
 * path 只收项目内的相对 .tex；`outDir` 只收相对 root 目录的相对目录；
 * `jobname` 只收裸文件名。三样都是「用户自己的配置」，但也别让界面把一个可执行
 * 配方 / 一个根外产物目录写进别人的目录。
 */
export async function writeLatexProjectConfig(
  projectDir: string,
  patch: LatexConfigPatch,
): Promise<void> {
  const dir = resolve(projectDir);
  // 旧配置没有 roots（v1 把 engine/outDir 写在项目级）：迁到「这次解析出来的有效 root」上，
  // 不然一次 chip 点击就会把这些旧字段丢掉。
  const resolved = resolveLatexPlan(dir, {});
  const fallbackRoot = resolved.status === "ok" ? resolved.root.path : null;
  const next = normalizeProjectConfig(readRawConfig(dir), fallbackRoot);

  const ensureRoot = (path: string): LatexRootConfig => {
    const existing = next.roots.find((root) => pathKey(root.path) === pathKey(path));
    if (existing !== undefined) return existing;
    const created: LatexRootConfig = { path };
    next.roots.push(created);
    return created;
  };

  if (patch.main !== undefined) {
    const main = requireRelativeTex(patch.main);
    next.activeRoot = main;
    ensureRoot(main);
  }

  if (patch.activate !== undefined) {
    const activate = requireRelativeTex(patch.activate);
    next.activeRoot = activate;
    ensureRoot(activate);
  }

  if (patch.root !== undefined) {
    const path = requireRelativeTex(patch.root.path);
    const target = ensureRoot(path);
    if (patch.root.engine !== undefined) target.engine = patch.root.engine;
    if (patch.root.outDir !== undefined) target.outDir = requireRelativeDir(patch.root.outDir);
    if (patch.root.jobname !== undefined) target.jobname = requireJobName(patch.root.jobname);
    if (patch.root.args !== undefined) target.args = patch.root.args;
    if (patch.root.recipe !== undefined) target.recipe = patch.root.recipe;
  }

  if (patch.removeRoot !== undefined) {
    const remove = requireRelativeTex(patch.removeRoot);
    next.roots = next.roots.filter((root) => pathKey(root.path) !== pathKey(remove));
    if (next.activeRoot !== null && pathKey(next.activeRoot) === pathKey(remove)) {
      next.activeRoot = next.roots[0]?.path ?? null;
    }
  }

  if (patch.engine !== undefined) {
    // engine 写到当前生效的 root：v2 里它属于一个 root，不是整个项目
    const target = next.activeRoot ?? next.roots[0]?.path ?? fallbackRoot;
    if (target === null) throw new Error("No root is selected, so an engine cannot be saved yet.");
    ensureRoot(target).engine = patch.engine;
  }

  if (patch.compileOnSave !== undefined) next.compileOnSave = patch.compileOnSave;

  const file = {
    version: 2 as const,
    activeRoot: next.activeRoot,
    roots: next.roots,
    ...(next.compileOnSave === undefined ? {} : { compileOnSave: next.compileOnSave }),
  };
  await writeJsonAtomic(join(dir, LATEX_CONFIG_PATH), file);
}

function requireRelativeTex(value: string): string {
  const text = value.trim();
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text) || text.split(/[\\/]/).includes("..")) {
    throw new Error("root must be a relative path inside the project");
  }
  if (extname(text).toLowerCase() !== ".tex") throw new Error("root must be a .tex file");
  return text.replace(/\\/g, "/");
}

function requireRelativeDir(value: string): string {
  const text = value.trim();
  if (text === "") throw new Error("outDir must not be empty");
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text) || text.split(/[\\/]/).includes("..")) {
    throw new Error("outDir must be relative to the root's directory (no absolute paths, no '..')");
  }
  return text.replace(/\\/g, "/").replace(/\/+$/, "");
}

function requireJobName(value: string): string {
  const text = value.trim();
  if (text === "" || /[\\/]/.test(text) || text === "." || text === ".." || /^[A-Za-z]:/.test(text)) {
    throw new Error("jobname must be a plain file name (no directory separators)");
  }
  return text;
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
