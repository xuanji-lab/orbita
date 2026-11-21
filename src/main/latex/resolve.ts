/**
 * 编译根解析与命令行配方 —— 决定「编哪个文件、用什么引擎、产物落哪、跑哪条 argv」。
 *
 * 纯模块（只碰 node:fs / node:path 的同步读），可被 `node --test` 直接加载：
 * 真的 spawn 在 run.ts，那边才 import 进程设施。
 *
 * 优先级（越靠前越权威）：
 *
 *   根：    请求显式给的 main > 当前文件头部的 % !TEX root > 配置的 activeRoot
 *           > 配置的旧字段 main > 目录里的 main.tex > 顶层唯一 .tex
 *           > 当前文件自己含 \documentclass > 递归唯一带 \documentclass 的 .tex
 *   引擎：  请求显式给的 > magic comment 的 program > 这个 root 的配置 > 自动判断
 *
 * magic comment 排在项目配置之前的理由：它跟着那个 .tex 走。同一个项目里放两篇
 * 中英混排的子文档时，项目级 engine 只能有一个，而 `% !TEX program = xelatex`
 * 写在哪份文件里就是哪份文件的事实（TeXShop 的语义，用户的手感来自那里）。
 * 主文件的 `% !TEX root` 是同一类东西：它声明的是「这个文件属于哪份主文件」，
 * 而 activeRoot 只记「我上次编的是哪份」——文件的明确声明不该被项目默认值盖掉，
 * 否则子文件里那一行 magic 永远不会被读到（那正是加 root 模型前的 bug）。
 *
 * 主文件是**唯一**的时候才自动选：多个根摆在一起时猜错会让用户对着一个编译
 * 通过的 PDF 找半天「为什么内容是旧的」，所以宁可回 no-main-file 并列出候选。
 *
 * **授权**：`boundary` 是调用方给的授权根（文件面板白名单 / 会话授权目录）。
 * magic 指到根外时**不跟**，回 `root-outside-workspace`——编译的工作目录与产物
 * 目录都由 root 推出，跟着一个根外的路径走等于把这两样都指到根外。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  LATEX_CONFIG_PATH,
  LATEX_DEFAULT_OUT_DIR,
  isLatexEngine,
  type LatexEngine,
  type LatexEngineSource,
  type LatexRootConfig,
  type LatexRootRef,
  type LatexRootSource,
} from "../../shared/latex.ts";
import { isInside } from "../path-boundary.ts";

/** 头部注释块里的 magic comment（TeXShop / TeXstudio + latexmk 的通行写法） */
export interface LatexMagic {
  /** `% !TEX program = …`，只认我们支持的三个引擎 */
  program: LatexEngine | null;
  /** `% !TEX root = …`：主文件（相对当前文件），会连带改变工作目录 */
  root: string | null;
  /** `% !TEX root` 写在第几行（1 基）；没写时 null。界面 chip 要说「由 ch1.tex:1 声明」 */
  rootLine: number | null;
  /** `% !TEX options = …`：原样拆成 argv（引号包住的一整段当一个参数） */
  options: string[];
}

/**
 * `.orbita/latex.json` 的形状。逐项可选——坏值丢弃，不让一个字段的笔误废掉整份配置。
 *
 * v2：`roots[]` 是每个编译根自己的配置（engine / outDir / jobname / args / recipe），
 * `activeRoot` 指向默认编哪一份。顶层的 main / engine / outDir / args / recipe 是
 * **v1 的旧字段**：读的时候当「隐式的第一个 root」用，写回时不再产出（见
 * normalizeProjectConfig）。
 */
export interface LatexProjectConfig {
  /** 文件里的版本号（原样保留；v1 没写） */
  version?: number;
  roots: LatexRootConfig[];
  activeRoot?: string;
  /**
   * 保存即编译（项目级开关）。只认布尔；缺省 = 关。
   * 它不参与编译 argv，只决定编辑器自动保存落定后要不要自动触发一次编译。
   */
  compileOnSave?: boolean;
  /* ── v1 旧字段：只读迁移 ── */
  main?: string;
  engine?: LatexEngine;
  outDir?: string;
  /** 追加在默认参数之后的额外 argv */
  args?: string[];
  /**
   * 自定义命令。**`recipe[0]` 是可执行文件，其余是它的参数**（不是「一整条 argv
   * 传给 latexmk」）——所以 `["latexmk", "-xelatex", …]` 与 `["-xelatex", …]`
   * 两种写法不会混淆。占位符只在参数里展开（可执行文件不展开）。
   * 给了它就完全不再拼默认参数。
   */
  recipe?: string[];
}

/** 一个 root 真正生效的那几项（roots[] 的条目 + v1 旧字段的迁移合并） */
export interface EffectiveRootConfig {
  engine?: LatexEngine;
  outDir?: string;
  jobname?: string;
  args?: string[];
  recipe?: string[];
}

export interface LatexResolveRequest {
  /** 请求里显式给的主文件（相对项目目录，或绝对路径） */
  main?: string;
  /**
   * 当前打开 / 刚编辑的文件（绝对路径，或相对项目目录）。只读它头部的 magic：
   * 这一条是「子文件里的 `% !TEX root` 生效」的唯一入口。
   */
  file?: string;
  /** 请求里显式给的引擎 */
  engine?: LatexEngine;
  /**
   * 授权根：root / magic 目标必须落在其中之一（绝对路径）。缺席时用 dir 自己。
   * 越界的目标回 `root-outside-workspace`，不把工作目录带出根外。
   */
  boundary?: readonly string[];
}

/** 解析成功的计划。run.ts 拿它原样 spawn */
export interface LatexPlan {
  status: "ok";
  /** 工作目录（主文件所在目录；magic root 改写过主文件时是**新**主文件的目录） */
  dir: string;
  /** 主文件绝对路径 */
  mainPath: string;
  /** 主文件名（相对 dir），传给 latexmk 的那一项 */
  mainName: string;
  /** 产物目录绝对路径（latexmk 的 -outdir，也是 log / pdf 的默认查找位置） */
  outDir: string;
  /** latexmk 的 -jobname；未配置为 null（= 主文件 basename） */
  jobname: string | null;
  /** 这次选中的根（相对项目目录）+ 它自己的配置结论 */
  root: LatexRootRef;
  engine: LatexEngine;
  engineSource: LatexEngineSource;
  /** 要起的可执行文件：recipe[0] 给了就用它（绝对或 PATH 上的名字）；null = 用探测到的 latexmk */
  command: string | null;
  /** 不含可执行文件的完整参数表 */
  argv: string[];
  magic: LatexMagic;
  config: LatexProjectConfig;
  /** 这个 root 生效的配置项（outDir / jobname / recipe 的迁移合并结果） */
  rootConfig: EffectiveRootConfig;
}

/** 解析失败：候选清单给模型/界面看，detail 是一句人话 */
export interface LatexPlanFailure {
  status: "no-main-file" | "root-outside-workspace";
  dir: string;
  candidates: string[];
  detail: string;
}

export type LatexResolution = LatexPlan | LatexPlanFailure;

/**
 * 只扫头部注释块：遇第一行**有内容的非注释行**即停（`\documentclass` 之后写的
 * `% !TEX` 不算数——TeXShop 也认这个位置）。空行与纯空白行不终止扫描：很多模板
 * 第一行是空行。注释块里的非 magic 注释照常忽略。
 */
export function parseMagicComments(source: string): LatexMagic {
  const magic: LatexMagic = { program: null, root: null, rootLine: null, options: [] };
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") continue;
    if (!line.startsWith("%")) break;
    const match = /^%\s*!TEX\s+(program|root|options)\s*=\s*(.*)$/i.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = unquote((match[2] ?? "").trim());
    if (value === "") continue;
    if (key === "program") magic.program = magicProgram(value);
    else if (key === "root") {
      magic.root = value;
      // 1 基行号：界面说「由 ch1.tex:1 声明」，模型回执用同一处事实
      magic.rootLine = index + 1;
    } else magic.options = splitOptions(value);
  }
  return magic;
}

/** `% !TEX program` 的常见写法 → 我们的引擎名。认不出的（如 "latex"）当没写 */
function magicProgram(value: string): LatexEngine | null {
  const name = value.toLowerCase();
  if (name === "xelatex") return "xelatex";
  if (name === "lualatex") return "lualatex";
  // pdflatex / pdftex / latexmk / pdf 都落到默认的 -pdf 车道
  if (name === "pdflatex" || name === "pdftex" || name === "latexmk" || name === "pdf") return "pdf";
  return null;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * `% !TEX options = -shell-escape -interaction=batchmode` 拆成 argv。
 * 引号包住的片段当一个参数（`-jobname="my paper"` 是常见的写法）：逐字符扫描，
 * 因为“带引号的值嵌在 `-flag=` 后面”没法用一条正则同时处理——正则的 `\S+`
 * 会在引号前面先把 token 吃掉一半。
 */
export function splitOptions(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let started = false;
  for (const char of value) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  // 空片段（`""`）没有意义：latexmk 会把空参数当文件名
  return tokens.filter((token) => token !== "");
}

/**
 * 解析 `.orbita/latex.json` 的内容；坏值逐项丢弃（返回值永远是合法对象）。
 *
 * **不做迁移写入**：v1 的 main / engine / outDir / args / recipe 原样留在字段里，
 * 由 `rootConfigFor` 在解析某一个 root 时合并生效；写回时才由
 * `normalizeProjectConfig` 升成 v2（见 project.ts 的写路径）。
 */
export function parseProjectConfig(raw: unknown): LatexProjectConfig {
  const config: LatexProjectConfig = { roots: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return config;
  const record = raw as Record<string, unknown>;
  if (typeof record["version"] === "number" && Number.isFinite(record["version"])) {
    config.version = record["version"];
  }
  // 旧字段：宽松（历史文件里可能写了绝对路径），解析时 resolve(dir, …) 照样能处理
  const main = nonEmpty(record["main"]);
  if (main !== undefined) config.main = main;
  if (isLatexEngine(record["engine"])) config.engine = record["engine"];
  const outDir = safeRelativeDir(record["outDir"]);
  if (outDir !== undefined) config.outDir = outDir;
  const args = stringList(record["args"]);
  if (args !== undefined) config.args = args;
  const recipe = stringList(record["recipe"]);
  if (recipe !== undefined) config.recipe = recipe;
  const activeRoot = nonEmpty(record["activeRoot"]);
  if (activeRoot !== undefined) config.activeRoot = activeRoot;
  // 非布尔（"true" / 1）当作没写：开关状态显示与实际行为不能分家（同 settings 的纪律）
  if (typeof record["compileOnSave"] === "boolean") config.compileOnSave = record["compileOnSave"];

  const rawRoots = Array.isArray(record["roots"]) ? record["roots"] : [];
  const seen = new Set<string>();
  for (const item of rawRoots) {
    const root = parseRootConfig(item);
    if (root === null) continue;
    const key = pathKey(root.path);
    if (seen.has(key)) {
      // 不静默：一份被丢掉的小节会让用户对着「配置了却没生效」找半天
      console.warn(`[latex] .orbita/latex.json 里的 root ${root.path} 重复，后一条被忽略`);
      continue;
    }
    seen.add(key);
    config.roots.push(root);
  }
  return config;
}

function parseRootConfig(value: unknown): LatexRootConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const path = projectRelativeTex(record["path"]);
  if (path === undefined) return null;
  const root: LatexRootConfig = { path };
  if (isLatexEngine(record["engine"])) root.engine = record["engine"];
  // outDir **相对这个 root 的目录**：绝对路径与 ".." 都不收——换机器就废，
  // 而且能把产物目录指到项目外。坏值丢弃（回默认 build）。
  const outDir = safeRelativeDir(record["outDir"]);
  if (outDir !== undefined) root.outDir = outDir;
  const jobname = safeJobName(record["jobname"]);
  if (jobname !== undefined) root.jobname = jobname;
  const args = stringList(record["args"]);
  if (args !== undefined) root.args = args;
  const recipe = stringList(record["recipe"]);
  if (recipe !== undefined) root.recipe = recipe;
  return root;
}

/** 写盘用的 v2 形状（`main` 等 v1 字段不再产出） */
export interface LatexProjectConfigV2 {
  version: 2;
  activeRoot: string | null;
  roots: LatexRootConfig[];
  compileOnSave?: boolean;
}

/**
 * 把磁盘上的（可能是 v1 的）配置升成 v2。**只用于写回**；解析时不做合并，
 * 否则「这个 root 的引擎是配置里写的还是 v1 顶层搬过来的」会丢。
 *
 * 迁移规则：
 * 1. v1 `main` 若不在 roots 里 → 追加一条，并把 engine / outDir / args / recipe 带过去；
 *    已经在 roots 里 → 这几项只补齐该条目缺的字段（roots[] 自己的值更具体）。
 * 2. 既没有 roots 也没有 main（旧的「整个项目一个 engine/outDir」写法）时，用调用方
 *    给的 fallbackRoot（这次解析出来的有效 root）建一条，把旧字段搬过去。
 * 3. `activeRoot` 必须命中某个 root：不命中就为它补一条（用户显式点过它），
 *    没有 activeRoot 时取 roots[0]（再没有就 null）。
 * 4. 重复 path 在 parse 阶段已经丢掉。
 */
export function normalizeProjectConfig(raw: unknown, fallbackRoot?: string | null): LatexProjectConfigV2 {
  const config = parseProjectConfig(raw);
  const roots = config.roots.map((root) => ({ ...root }));
  if (config.main !== undefined) {
    const legacy: EffectiveRootConfig = {
      ...(config.engine === undefined ? {} : { engine: config.engine }),
      ...(config.outDir === undefined ? {} : { outDir: config.outDir }),
      ...(config.args === undefined ? {} : { args: config.args }),
      ...(config.recipe === undefined ? {} : { recipe: config.recipe }),
    };
    const index = roots.findIndex((root) => pathKey(root.path) === pathKey(config.main ?? ""));
    if (index >= 0) {
      const target = roots[index];
      if (target !== undefined) {
        if (target.engine === undefined && legacy.engine !== undefined) target.engine = legacy.engine;
        if (target.outDir === undefined && legacy.outDir !== undefined) target.outDir = legacy.outDir;
        if (target.args === undefined && legacy.args !== undefined) target.args = legacy.args;
        if (target.recipe === undefined && legacy.recipe !== undefined) target.recipe = legacy.recipe;
      }
    } else {
      roots.push({ path: config.main, ...legacy });
    }
  }
  if (roots.length === 0 && fallbackRoot !== undefined && fallbackRoot !== null && fallbackRoot !== "") {
    const migrated: LatexRootConfig = { path: fallbackRoot };
    if (config.engine !== undefined) migrated.engine = config.engine;
    if (config.outDir !== undefined) migrated.outDir = config.outDir;
    if (config.args !== undefined) migrated.args = config.args;
    if (config.recipe !== undefined) migrated.recipe = config.recipe;
    roots.push(migrated);
  }
  let activeRoot = config.activeRoot ?? config.main ?? roots[0]?.path ?? null;
  if (activeRoot !== null && !roots.some((root) => pathKey(root.path) === pathKey(activeRoot ?? ""))) {
    roots.push({ path: activeRoot });
  }
  if (activeRoot === null) activeRoot = roots[0]?.path ?? null;
  return {
    version: 2,
    activeRoot,
    roots,
    ...(config.compileOnSave === undefined ? {} : { compileOnSave: config.compileOnSave }),
  };
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return list.length > 0 ? list : undefined;
}

/** 配置里的 root 路径：必须是项目内的相对 .tex（正斜杠 normalize） */
function projectRelativeTex(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text)) return undefined;
  if (text.split(/[\\/]/).includes("..")) return undefined;
  if (extname(text).toLowerCase() !== ".tex") return undefined;
  return text.replace(/\\/g, "/");
}

/** 配置里的目录：相对、不含 `..`、不是绝对路径 */
function safeRelativeDir(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text)) return undefined;
  if (text.split(/[\\/]/).includes("..")) return undefined;
  return text.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** jobname 必须是裸文件名（latexmk 会把它拼成产物名，带路径就等于换目录） */
function safeJobName(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  if (/[\\/]/.test(text) || text === "." || text === ".." || /^[A-Za-z]:/.test(text)) return undefined;
  return text;
}

/** 主文件解析。deps 只为测试留的：默认就查真盘 */
export interface LatexResolveDeps {
  exists(path: string): boolean;
  read(path: string): string;
  list(dir: string): string[];
  /** realpath；读不了（不存在 / 权限）回 null。授权判定用它堵 symlink 跳板 */
  real(path: string): string | null;
}

const realFs: LatexResolveDeps = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf8"),
  list: (dir) => readdirSync(dir),
  real: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

/**
 * 从请求 + 目录内容解析出完整计划。**不 spawn、不写盘**。
 * `request` 里的 main / file / engine 来自 agent 工具或 renderer（显式意愿）。
 */
export function resolveLatexPlan(
  dirInput: string,
  request: LatexResolveRequest = {},
  deps: LatexResolveDeps = realFs,
): LatexResolution {
  const dir = resolve(dirInput);
  const config = readProjectConfigWith(deps, dir);
  const boundary = (request.boundary ?? [dir]).map((item) => resolve(item));
  const found = chooseRoot(dir, request, config, deps, boundary);
  if (!found.ok) return { status: found.status, dir, candidates: found.candidates, detail: found.detail };

  /*
   * 选中的文件如果自己写了 `% !TEX root`，说明它「不是那份文档」——按约定 / 配置 /
   * 扫描选出来的 root 要跟着它走（旧行为，也是文件内声明的意义）。**request.main
   * 例外**：显式给的 main 是本次请求的最终裁决（界面上的「忽略 magic、编这一份」
   * 就靠它），不再被文件内容改写。request.file 的 magic 在 chooseRoot 里已经跟过。
   */
  let mainPath = found.path;
  let rootSource = found.source;
  let declaredBy = found.declaredBy;
  if (found.source !== "request" && found.source !== "magic") {
    const traced = traceMagicRoot(dir, mainPath, deps, boundary);
    if (traced !== "none") {
      if (!traced.ok) {
        return { status: traced.status, dir, candidates: traced.candidates, detail: traced.detail };
      }
      mainPath = traced.path;
      rootSource = "magic";
      declaredBy = traced.declaredBy;
    }
  }
  /*
   * 最后一道闸：**任何来源**选出的主文件都必须落在授权根内。显式 main 与 magic 在
   * 各自的解析里已经查过；这一道兜住手工改过的配置（activeRoot 写了个绝对路径）
   * 与扫描结果里的 symlink——工作目录与产物目录都由它推出，不能出根。
   */
  if (!insideBoundary(mainPath, boundary, deps)) {
    return {
      status: "root-outside-workspace",
      dir,
      candidates: discoverRoots(dir, deps),
      detail:
        `The selected main file ${mainPath} is outside the authorized workspace. ` +
        "Compiling it would put the working directory and the artifacts outside the workspace, so it was refused.",
    };
  }
  const workDir = dirname(mainPath);
  const magic = readMagic(deps, mainPath);
  const mainName = relativeName(workDir, mainPath);
  const rootPath = relativeName(dir, mainPath).replace(/\\/g, "/");
  const rootConfig = rootConfigFor(config, rootPath);
  const outDir = resolve(workDir, rootConfig.outDir ?? LATEX_DEFAULT_OUT_DIR);
  const jobname = rootConfig.jobname ?? null;
  const source = readText(deps, mainPath);
  const picked = pickEngine(request.engine, magic.program, rootConfig.engine, source);
  const built = buildArgv({
    config: rootConfig,
    magic,
    mainName,
    dir: workDir,
    outDir,
    jobname,
    engine: picked.engine,
  });

  return {
    status: "ok",
    dir: workDir,
    mainPath,
    mainName,
    outDir,
    jobname,
    root: {
      path: rootPath,
      source: rootSource,
      declaredBy,
      engine: picked.engine,
      engineSource: picked.source,
      outDir,
      outDirRelative: relativeName(dir, outDir).replace(/\\/g, "/"),
      jobname,
    },
    engine: picked.engine,
    engineSource: picked.source,
    command: built.command,
    argv: built.argv,
    magic,
    config,
    rootConfig,
  };
}

/** 一个 root 在配置里的生效值：roots[] 的条目 + v1 旧字段（只在它自己身上生效） */
function rootConfigFor(config: LatexProjectConfig, rootPath: string): EffectiveRootConfig {
  const key = pathKey(rootPath);
  const entry = config.roots.find((root) => pathKey(root.path) === key);
  // v1 配置里的 engine / outDir / args / recipe 是**项目级**的：写了 main 就只落在那一份上，
  // 没写 main（旧文件的常见形态）时落到这次选中的 root 上（历史行为不变）。
  const legacyApplies =
    config.main !== undefined ? pathKey(config.main) === key : config.roots.length === 0;
  const merged: EffectiveRootConfig = {};
  const engine = entry?.engine ?? (legacyApplies ? config.engine : undefined);
  if (engine !== undefined) merged.engine = engine;
  const outDir = entry?.outDir ?? (legacyApplies ? config.outDir : undefined);
  if (outDir !== undefined) merged.outDir = outDir;
  if (entry?.jobname !== undefined) merged.jobname = entry.jobname;
  // args / recipe 相加没有意义（两条命令拼一起），条目自己的优先，其次才是 v1 的
  const args = entry?.args ?? (legacyApplies ? config.args : undefined);
  if (args !== undefined) merged.args = args;
  const recipe = entry?.recipe ?? (legacyApplies ? config.recipe : undefined);
  if (recipe !== undefined) merged.recipe = recipe;
  return merged;
}

function readProjectConfigWith(deps: LatexResolveDeps, dir: string): LatexProjectConfig {
  const path = join(dir, LATEX_CONFIG_PATH);
  if (!deps.exists(path)) return { roots: [] };
  try {
    return parseProjectConfig(JSON.parse(deps.read(path)) as unknown);
  } catch (cause) {
    console.warn(`[latex] 读不了 ${path}，按没有配置处理：`, cause);
    return { roots: [] };
  }
}

function readMagic(deps: LatexResolveDeps, mainPath: string): LatexMagic {
  return parseMagicComments(readText(deps, mainPath));
}

/** 读不到文件时回 null（与「读了但没有 magic」区分：magic 链要停在这里） */
function readMagicOrNull(deps: LatexResolveDeps, path: string): LatexMagic | null {
  try {
    return parseMagicComments(deps.read(path));
  } catch {
    return null;
  }
}

function readText(deps: LatexResolveDeps, path: string): string {
  try {
    return deps.read(path);
  } catch (cause) {
    console.warn(`[latex] 读不了 ${path}：`, cause);
    return "";
  }
}

function relativeName(dir: string, path: string): string {
  // 用 path.relative 而不是 startsWith + slice：`C:\a\b` 与 `C:\a\bc\main.tex`
  // 的前缀判断会切出 `c\main.tex`（评审 A9）。切不出来的（真的不在 dir 下）
  // 退回绝对路径，交给 latexmk 自己报错。
  const rel = relative(dir, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/**
 * root 的展示路径：相对项目目录、正斜杠；**允许 `..`**（magic 指到项目目录之外、
 * 但仍在授权根内时是合法的，如 `../book/main.tex`）。不套 relativeName——那个
 * 对越界路径回绝对路径，是给 latexmk 的 argv 用的，不是给界面看的。
 */
function rootPathOf(dir: string, path: string): string {
  const rel = relative(dir, path);
  return (rel === "" ? basename(path) : rel).replace(/\\/g, "/");
}

/** 目录的展示路径：相对项目目录、正斜杠；就是项目目录本身时 "." */
function displayRelative(dir: string, path: string): string {
  const rel = relative(dir, path);
  return (rel === "" ? "." : rel).replace(/\\/g, "/");
}

/** 同一个文件的判等键（Windows 大小写不敏感；resolve 掉 `.` / `..`） */
function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

type RootChoice = {
  ok: true;
  path: string;
  source: LatexRootSource;
  declaredBy: { file: string; line: number } | null;
};

type RootFailure = {
  ok: false;
  status: LatexPlanFailure["status"];
  candidates: string[];
  detail: string;
};

/**
 * 按优先级选根。**显式给的 main 不存在时不再回落**：模型说「编 paper.tex」，
 * 我们悄悄去编 main.tex，它拿到的 PDF 与它以为的不是同一份。
 */
function chooseRoot(
  dir: string,
  request: LatexResolveRequest,
  config: LatexProjectConfig,
  deps: LatexResolveDeps,
  boundary: readonly string[],
): RootChoice | RootFailure {
  // 1. 请求显式给的 main
  if (request.main !== undefined) {
    const explicit = explicitMain(dir, request.main, deps, boundary);
    if (!explicit.ok) return explicit;
    return { ok: true, path: explicit.path, source: "request", declaredBy: null };
  }

  // 2. 当前文件头部的 % !TEX root
  const fileAbs = request.file === undefined
    ? null
    : isAbsolute(request.file)
      ? resolve(request.file)
      : resolve(dir, request.file);
  if (fileAbs !== null) {
    const magic = traceMagicRoot(dir, fileAbs, deps, boundary);
    if (magic !== "none") return magic;
  }

  // 3. 配置的 activeRoot（显式点过的那一份）
  if (config.activeRoot !== undefined) {
    const active = resolve(dir, config.activeRoot);
    if (deps.exists(active) && isFile(deps, active)) {
      return { ok: true, path: active, source: "active", declaredBy: null };
    }
    // 指向的文件不在了：继续往下找，不因为一次删除就把整个项目变成不可编
  }

  // 4. 配置的 v1 main（同样不回落：写了就必须存在）
  if (config.main !== undefined) {
    const legacy = explicitMain(dir, config.main, deps, boundary);
    if (!legacy.ok) return legacy;
    return { ok: true, path: legacy.path, source: "config", declaredBy: null };
  }

  // 5. 约定：目录里的 main.tex
  const conventional = join(dir, "main.tex");
  if (deps.exists(conventional)) {
    return { ok: true, path: conventional, source: "convention", declaredBy: null };
  }

  // 6. 顶层唯一 .tex
  const texFiles = listTexFiles(dir, deps);
  if (texFiles.length === 1) {
    const only = texFiles[0] ?? "";
    return { ok: true, path: join(dir, only), source: "unique", declaredBy: null };
  }

  // 7. 当前文件自己就是一份完整文档（用户正看着它，编它最不意外）
  if (fileAbs !== null && hasDocumentClass(deps, fileAbs)) {
    return { ok: true, path: fileAbs, source: "focus", declaredBy: null };
  }

  // 8. 递归 ≤2 层里唯一带 \documentclass 的 .tex
  const candidates = discoverRoots(dir, deps);
  if (candidates.length === 1) {
    const only = candidates[0] ?? "";
    return { ok: true, path: join(dir, only), source: "scan", declaredBy: null };
  }

  // 9. 认不出来：候选给模型/界面，别静默猜一个
  const list = candidates.length > 0 ? candidates : texFiles;
  return {
    ok: false,
    status: "no-main-file",
    candidates: list,
    detail:
      list.length === 0
        ? `No .tex file in ${dir}.`
        : `${dir} has ${String(list.length)} .tex files and no main.tex — pass main to say which one to compile.`,
  };
}

/**
 * 显式 main 的校验（请求 / v1 配置共用）：必须是 .tex、必须存在、必须在授权根内。
 * renderer 的 chip 点选走这里，agent 的 `main` 另有一道 mainInsideDir（入口更严）。
 */
function explicitMain(
  dir: string,
  explicit: string,
  deps: LatexResolveDeps,
  boundary: readonly string[],
): { ok: true; path: string } | RootFailure {
  const path = isAbsolute(explicit) ? resolve(explicit) : resolve(dir, explicit);
  if (extname(path).toLowerCase() !== ".tex") {
    return {
      ok: false,
      status: "no-main-file",
      candidates: listTexFiles(dir, deps),
      detail: `The main file must be a .tex file (got ${path}).`,
    };
  }
  if (!deps.exists(path) || !isFile(deps, path)) {
    return {
      ok: false,
      status: "no-main-file",
      candidates: listTexFiles(dir, deps),
      detail: `The requested main file ${path} does not exist.`,
    };
  }
  if (!insideBoundary(path, boundary, deps)) {
    return {
      ok: false,
      status: "root-outside-workspace",
      candidates: listTexFiles(dir, deps),
      detail:
        `The main file ${path} is outside the authorized workspace. ` +
        "Compiling it would put the working directory and the artifacts outside the workspace, so it was refused.",
    };
  }
  return { ok: true, path };
}

/**
 * 跟 `% !TEX root`：从当前文件起，最多 2 跳（A→B→C 停在 C）。
 *
 * 三条边界：
 * - 指回自己 → 不是错误，当没写（继续走配置 / 约定）；
 * - 撞环（visited）→ 停在环上，不无限跟；
 * - 目标不存在 → 回 no-main-file，文案说清「哪份文件的第几行指向了什么」；
 * - 目标在授权根外 → root-outside-workspace，**不跟**（cwd / outDir 会跟着出去）。
 */
function traceMagicRoot(
  dir: string,
  startAbs: string,
  deps: LatexResolveDeps,
  boundary: readonly string[],
): RootChoice | RootFailure | "none" {
  let current = startAbs;
  let magic = readMagicOrNull(deps, current);
  if (magic === null || magic.root === null) return "none";

  const visited = new Set<string>([pathKey(current)]);
  let declaredBy: { file: string; line: number } | null = null;
  for (let moves = 0; moves < 2; moves += 1) {
    const root = magic?.root ?? null;
    if (root === null) break;
    const target = isAbsolute(root) ? resolve(root) : resolve(dirname(current), root);
    // 指回自己 / 绕了一圈：当没写（TeXShop 也忽略这种），继续往下找
    if (visited.has(pathKey(target))) break;
    declaredBy = {
      file: relativeName(dir, current).replace(/\\/g, "/"),
      line: magic?.rootLine ?? 1,
    };
    visited.add(pathKey(target));
    current = target;
    magic = readMagicOrNull(deps, current);
  }
  if (declaredBy === null) return "none";

  const declared = `"% !TEX root" in ${declaredBy.file}:${String(declaredBy.line)}`;
  if (!deps.exists(current) || !isFile(deps, current)) {
    return {
      ok: false,
      status: "no-main-file",
      candidates: discoverRoots(dir, deps),
      detail: `${declaredBy.file} line ${String(declaredBy.line)} points at ${current} (${declared}), but that file does not exist.`,
    };
  }
  if (extname(current).toLowerCase() !== ".tex") {
    return {
      ok: false,
      status: "no-main-file",
      candidates: discoverRoots(dir, deps),
      detail: `${declared} does not point at a .tex file (got ${current}).`,
    };
  }
  if (!insideBoundary(current, boundary, deps)) {
    return {
      ok: false,
      status: "root-outside-workspace",
      candidates: discoverRoots(dir, deps),
      detail:
        `${declared} points at ${current}, which is outside the authorized workspace. ` +
        "Compiling it would put the working directory and the artifacts outside the workspace, so it was refused.",
    };
  }
  return { ok: true, path: current, source: "magic", declaredBy };
}

/**
 * 目标是否落在授权根之一内。词法判一次（快），再 realpath 判一次（堵 symlink /
 * junction 跳板；两侧都读不出来时只信词法结论）。判据复用 `main/path-boundary.ts`
 * 的 isInside——主进程里所有「按别人给的路径读盘」的入口共用那一份。
 */
function insideBoundary(
  path: string,
  boundary: readonly string[],
  deps: LatexResolveDeps,
): boolean {
  for (const root of boundary) {
    if (isInside(root, path)) return true;
    const realPath = deps.real(path);
    const realRoot = deps.real(root);
    if (realPath !== null && realRoot !== null && isInside(realRoot, realPath)) return true;
  }
  return false;
}

function isFile(deps: LatexResolveDeps, path: string): boolean {
  // 注入点没有 stat：目录名以 .tex 结尾是极少数，用 read 试探一次就够
  try {
    deps.read(path);
    return true;
  } catch {
    return false;
  }
}

/** 项目目录顶层的 .tex（不递归：子目录里的通常是 \input 的片段，不是主文件） */
function listTexFiles(dir: string, deps: LatexResolveDeps): string[] {
  let entries: string[];
  try {
    entries = deps.list(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => extname(name).toLowerCase() === ".tex" && !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** 递归发现 root 的深度上限：论文项目的根一般就在顶层或一层子目录（paper/ slides/） */
const SCAN_MAX_DEPTH = 2;

/** 递归时跳过的目录：产物、依赖、版本库、配置目录 */
const SCAN_SKIP_DIRS = new Set(["node_modules", "build", "out", "dist", ".git", ".svn", ".orbita"]);

/** 一次扫描最多看几个目录条目：防一个巨大的目录把面板拖住 */
const SCAN_MAX_ENTRIES = 500;

/** 判断一份 .tex 是不是文档根时只读头部这么多字节——\documentclass 总在导言区 */
const HEAD_BYTES = 8 * 1024;

/**
 * 项目里所有 root 候选：递归 ≤2 层、头部带 `\documentclass` 的 .tex（相对项目目录，正斜杠）。
 *
 * 轻量扫描（只看文件头部），不整篇解析：这个函数在面板每 4 秒的轮询里跑。
 * 一个都没有时退回顶层 .tex——「目录里就是几个零散文件」时界面仍要能选一个。
 */
export function discoverRoots(dir: string, deps: LatexResolveDeps = realFs): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (current: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || seen >= SCAN_MAX_ENTRIES) return;
    let entries: string[];
    try {
      entries = deps.list(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (seen >= SCAN_MAX_ENTRIES) return;
      if (name.startsWith(".")) continue;
      const path = join(current, name);
      let directory = false;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (directory) {
        if (SCAN_SKIP_DIRS.has(name)) continue;
        walk(path, depth + 1);
        continue;
      }
      if (extname(name).toLowerCase() !== ".tex") continue;
      seen += 1;
      if (!hasDocumentClass(deps, path)) continue;
      found.push(relativeName(dir, path).replace(/\\/g, "/"));
    }
  };
  walk(dir, 0);
  found.sort();
  return found.length > 0 ? found : listTexFiles(dir, deps);
}

/** 文件头部 8 KB 里有没有 `\documentclass`（只看开头：文档类在导言区） */
function hasDocumentClass(deps: LatexResolveDeps, path: string): boolean {
  try {
    return /\\documentclass\b/.test(deps.read(path).slice(0, HEAD_BYTES));
  } catch {
    return false;
  }
}

function pickEngine(
  requested: LatexEngine | undefined,
  magic: LatexEngine | null,
  configured: LatexEngine | undefined,
  source: string,
): { engine: LatexEngine; source: LatexEngineSource } {
  if (requested !== undefined) return { engine: requested, source: "request" };
  if (magic !== null) return { engine: magic, source: "magic" };
  if (configured !== undefined) return { engine: configured, source: "config" };
  return { engine: detectEngine(source), source: "auto" };
}

/**
 * 自动判断引擎：文档里有中文（或日韩文）就走 xelatex——pdflatex 对 CJK 只能靠
 * CJKutf8 + 一堆字体开关，xelatex 是 ctex 的默认车道。
 *
 * 认三种信号：ctex 宏包、ctex 文档类、正文里的 CJK 字符。**注释行先剔除**——
 * 一份英文论文的头部写一行中文注释不该把引擎换成 xelatex（换了也能出 PDF，
 * 但字体与断行全变，用户会以为排版坏了）。
 */
export function detectEngine(source: string): LatexEngine {
  const body = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("%"))
    .join("\n");
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\bctex\b[^}]*\}/.test(body)) return "xelatex";
  if (/\\documentclass(\[[^\]]*\])?\{ctex(art|book|rep|beamer)\}/.test(body)) return "xelatex";
  // CJK 统一表意文字（含扩展 A）、平假名/片假名/谚文：这些字符在 pdflatex 下必然缺字
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(body)) return "xelatex";
  return "pdf";
}

/** 引擎 → latexmk 的开关 */
function engineFlag(engine: LatexEngine): string {
  return engine === "pdf" ? "-pdf" : `-${engine}`;
}

interface ArgvInput {
  config: EffectiveRootConfig;
  magic: LatexMagic;
  /** 主文件名（相对 dir） */
  mainName: string;
  dir: string;
  outDir: string;
  jobname: string | null;
  engine: LatexEngine;
}

/** 可执行文件与参数分开给：recipe[0] 是命令，其余才是参数 */
interface BuiltArgv {
  command: string | null;
  argv: string[];
}

/**
 * 拼命令与 argv。
 *
 * 默认：latexmk（command = null，由 run.ts 用探测到的可执行文件）+
 * `-pdf|-xelatex|-lualatex -interaction=nonstopmode -file-line-error -synctex=1
 * -outdir=<abs> [-jobname=<name>] <main>`
 *
 * - `recipe` 给了就完全照它来：**recipe[0] 是可执行文件**，`recipe.slice(1)` 是参数，
 *   占位符只在参数里展开。这正是「整条命令」的字面语义（评审 M1：以前把
 *   recipe[0] 也当参数传给 latexmk，写 `["latexmk", …]` 的配置必挂）。
 * - `args` / magic options 叠在默认参数之后、主文件名之前（latexmk 的选项都在文件前）。
 * - outdir 用**绝对路径**：magic root 会把工作目录改到别处，相对路径的含义
 *   随 cwd 漂移。run.ts 先按 outDir 找 log/pdf，找不到再回退到主文件目录与
 *   日志里的 `Output written on`（自定义 recipe 可以不带 -outdir）。
 * - `-jobname` 让产物不叫 `<main>.pdf`：面板与 agent 的产物定位**不再假设文件名**
 *   （run.ts 按日志 / 快照判定，project.ts 也认 jobname）。
 */
function buildArgv(input: ArgvInput): BuiltArgv {
  const context = {
    doc: basename(input.mainName, extname(input.mainName)),
    docfile: input.mainName,
    dir: input.dir,
    outdir: input.outDir,
  };
  if (input.config.recipe !== undefined) {
    const [command, ...args] = input.config.recipe;
    return { command: command ?? null, argv: expandRecipe(args, context) };
  }
  return {
    command: null,
    argv: [
      engineFlag(input.engine),
      "-interaction=nonstopmode",
      "-file-line-error",
      "-synctex=1",
      `-outdir=${input.outDir}`,
      ...(input.jobname === null ? [] : [`-jobname=${input.jobname}`]),
      ...(input.config.args ?? []),
      ...input.magic.options,
      input.mainName,
    ],
  };
}

/**
 * 占位符展开（recipe 的**参数部分**；可执行文件不展开）：
 *
 *   %DOC%     主文件名去掉 .tex（"main"）
 *   %DOCFILE% 主文件名（"main.tex" / "sub/paper.tex"）
 *   %DIR%     工作目录（绝对）
 *   %OUTDIR%  产物目录（绝对）
 *
 * 未知的 `%FOO%` 原样保留：latexmk 自己也用 `%` 少，而静默删掉一个我们不认识的
 * 占位符会让用户对着一条少了参数的命令找半天。
 */
export function expandRecipe(
  recipe: readonly string[],
  context: { doc: string; docfile: string; dir: string; outdir: string },
): string[] {
  return recipe.map((token) =>
    token
      .replaceAll("%DOCFILE%", context.docfile)
      .replaceAll("%DOC%", context.doc)
      .replaceAll("%OUTDIR%", context.outdir)
      .replaceAll("%DIR%", context.dir),
  );
}
