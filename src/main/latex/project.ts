/**
 * 「这个文件属于哪个 LaTeX 项目」—— 编译条的第一问，也是 renderer 唯一能拿到的
 * 项目描述（`latex:project`）。
 *
 * 项目目录 = 从文件所在目录往上找到的**最近一个** LaTeX 项目：
 *   - 有 `.orbita/latex.json`（用户显式指定过引擎 / 主文件），或
 *   - 顶层有带 `\documentclass` 的 .tex（原型裁决：不是「目录里有 .tex 就算」——
 *     很多仓库的 docs/ 里躺着零散片段，编译条不该在那里出现）。
 * 往上找到文件面板的根为止：不越出白名单，也不把上层仓库误认成项目。
 *
 * 只读盘、不起进程：`latexmk` 的探测在 probe.ts，编译在 run.ts。这里给界面的是
 * 「编什么、用什么编、磁盘上的 PDF 是不是比源码旧」三件事的事实。
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  LATEX_CONFIG_PATH,
  type LatexEngine,
  type LatexProjectInfo,
} from "../../shared/latex.ts";
import { writeJsonAtomic } from "../atomic-write.ts";
import { samePath } from "../../shared/path.ts";
import { detectEngine, parseProjectConfig, resolveLatexPlan, type LatexPlan, type LatexProjectConfig } from "./resolve.ts";

/** 项目探测里算「源码」的扩展名：改这些会让 PDF 过期 */
const SOURCE_EXTS = new Set([".tex", ".bib", ".cls", ".sty"]);

/** 递归扫源码时跳过的目录名（隐藏目录另判）：产物、依赖、版本库 */
const SKIP_DIRS = new Set(["node_modules", "build", "out", "dist", ".git", ".svn"]);

/** 递归上限：论文项目的源码一般两三层，再深多半是误入别人的仓库 */
const MAX_DEPTH = 3;

/** 每个目录最多收的条目：防止在一个巨大的目录里把面板拖死 */
const MAX_ENTRIES = 500;

/** 判断顶层 .tex 是不是文档根时只读头部这么多字节——\documentclass 总在导言区 */
const HEAD_BYTES = 8 * 1024;

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

/** 显式配置，或顶层真有 `\documentclass` 的 .tex */
function looksLikeLatexProject(dir: string): boolean {
  if (existsSync(join(dir, LATEX_CONFIG_PATH))) return true;
  for (const name of topLevelTex(dir)) {
    if (hasDocumentClass(join(dir, name))) return true;
  }
  return false;
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
    return {};
  }
}

/**
 * 项目描述。主文件解析复用 `resolveLatexPlan`——编译条看到的「会用哪个主文件、
 * 哪个引擎」必须就是编译时真正用的那一个，不能在这里另写一份优先级。
 */
export function describeLatexProject(projectDir: string): LatexProjectInfo {
  const dir = resolve(projectDir);
  const config = readConfig(dir);
  const plan = resolveLatexPlan(dir, {});

  const mains = topLevelTex(dir);
  if (plan.status === "ok" && !mains.includes(plan.mainName)) mains.push(plan.mainName);

  const detail = plan.status === "no-main-file" ? plan.detail : null;
  const engine: LatexEngine = plan.status === "ok"
    ? plan.engine
    : (config.engine ?? autoEngineOf(dir, mains));
  const engineSource: LatexProjectInfo["engineSource"] = plan.status === "ok"
    ? (plan.engineSource === "magic" || plan.engineSource === "config" ? plan.engineSource : "auto")
    : (config.engine === undefined ? "auto" : "config");

  const projectDirForCompile = plan.status === "ok" ? plan.dir : dir;
  const pdf = plan.status === "ok" ? locatePdf(plan) : null;
  const sourceModifiedAt = newestSource(plan.status === "ok" ? plan.mainPath : null, projectDirForCompile);

  return {
    dir: projectDirForCompile,
    engine,
    engineSource,
    main: plan.status === "ok" ? plan.mainName : null,
    mains,
    configured: {
      ...(config.main === undefined ? {} : { main: config.main }),
      ...(config.engine === undefined ? {} : { engine: config.engine }),
    },
    pdf,
    sourceModifiedAt,
    detail,
    // 明确写 false 的也是关（与缺席同一个行为），界面只需要一个是非值
    compileOnSave: config.compileOnSave === true,
  };
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
 * 产物位置不假定在 outDir（自定义 recipe 可以不带 -outdir）：先按 outDir 找，
 * 再按主文件目录找——与 run.ts 的 locatePdf 同一顺序。
 */
function locatePdf(plan: LatexPlan): LatexProjectInfo["pdf"] {
  const base = basename(plan.mainName, extname(plan.mainName));
  for (const candidate of [join(plan.outDir, `${base}.pdf`), join(dirname(plan.mainPath), `${base}.pdf`)]) {
    try {
      const stats = statSync(candidate);
      if (stats.isFile()) return { path: candidate, modifiedAt: stats.mtimeMs };
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

/**
 * 把引擎 / 主文件的选择写进项目 `.orbita/latex.json`（原子写）。
 *
 * **合并而不是覆盖**：用户手写的 outDir / args / recipe 不能被一次 chip 点击抹掉。
 * `main` 只收项目内的相对 .tex（绝对路径与 `..` 一律拒绝——这是用户自己的配置，
 * 但也别让界面把一个可执行配方写进别人的目录）。
 */
export async function writeLatexProjectConfig(
  projectDir: string,
  patch: { main?: string; engine?: LatexEngine; compileOnSave?: boolean },
): Promise<void> {
  const dir = resolve(projectDir);
  if (patch.main !== undefined) {
    if (isAbsolute(patch.main) || patch.main.includes("..")) {
      throw new Error("main must be a relative path inside the project");
    }
    if (extname(patch.main).toLowerCase() !== ".tex") {
      throw new Error("main must be a .tex file");
    }
  }
  const raw = readConfig(dir);
  const merged: LatexProjectConfig = {
    ...raw,
    ...(patch.main === undefined ? {} : { main: patch.main }),
    ...(patch.engine === undefined ? {} : { engine: patch.engine }),
    ...(patch.compileOnSave === undefined ? {} : { compileOnSave: patch.compileOnSave }),
  };
  await writeJsonAtomic(join(dir, LATEX_CONFIG_PATH), merged);
}
