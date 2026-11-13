/**
 * 主文件解析与命令行配方 —— 决定「编哪个文件、用什么引擎、跑哪条 argv」。
 *
 * 纯模块（只碰 node:fs / node:path 的同步读），可被 `node --test` 直接加载：
 * 真的 spawn 在 run.ts，那边才 import 进程设施。
 *
 * 优先级（越靠前越权威）：
 *
 *   主文件：请求显式给的 > .orbita/latex.json 的 main > 目录里的 main.tex > 唯一 .tex
 *   引擎：  请求显式给的 > magic comment 的 program > .orbita/latex.json 的 engine > 自动判断
 *
 * magic comment 排在项目配置之前的理由：它跟着那个 .tex 走。同一个项目里放两篇
 * 中英混排的子文档时，项目级 engine 只能有一个，而 `% !TEX program = xelatex`
 * 写在哪份文件里就是哪份文件的事实（TeXShop 的语义，用户的手感来自那里）。
 *
 * 主文件是**唯一**的时候才自动选：多个 .tex 摆在一起时猜错会让用户对着一个编译
 * 通过的 PDF 找半天「为什么内容是旧的」，所以宁可回 no-main-file 并列出候选。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  LATEX_CONFIG_PATH,
  LATEX_DEFAULT_OUT_DIR,
  isLatexEngine,
  type LatexEngine,
} from "../../shared/latex.ts";

/** 头部注释块里的 magic comment（TeXShop / TeXstudio + latexmk 的通行写法） */
export interface LatexMagic {
  /** `% !TEX program = …`，只认我们支持的三个引擎 */
  program: LatexEngine | null;
  /** `% !TEX root = …`：主文件（相对当前文件），会连带改变工作目录 */
  root: string | null;
  /** `% !TEX options = …`：原样拆成 argv（引号包住的一整段当一个参数） */
  options: string[];
}

/** `.orbita/latex.json` 的形状。逐项可选——坏值丢弃，不让一个字段的笔误废掉整份配置 */
export interface LatexProjectConfig {
  main?: string;
  engine?: LatexEngine;
  outDir?: string;
  /** 追加在默认参数之后的额外 argv */
  args?: string[];
  /**
   * 保存即编译（项目级开关）。只认布尔；缺省 = 关。
   * 它不参与编译 argv，只决定编辑器自动保存落定后要不要自动触发一次编译。
   */
  compileOnSave?: boolean;
  /**
   * 自定义命令。**`recipe[0]` 是可执行文件，其余是它的参数**（不是「一整条 argv
   * 传给 latexmk」）——所以 `["latexmk", "-xelatex", …]` 与 `["-xelatex", …]`
   * 两种写法不会混淆。占位符只在参数里展开（可执行文件不展开）。
   * 给了它就完全不再拼默认参数。
   */
  recipe?: string[];
}

export interface LatexResolveRequest {
  /** 请求里显式给的主文件（相对项目目录，或绝对路径） */
  main?: string;
  /** 请求里显式给的引擎 */
  engine?: LatexEngine;
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
  engine: LatexEngine;
  engineSource: "request" | "magic" | "config" | "auto";
  /** 要起的可执行文件：recipe[0] 给了就用它（绝对或 PATH 上的名字）；null = 用探测到的 latexmk */
  command: string | null;
  /** 不含可执行文件的完整参数表 */
  argv: string[];
  magic: LatexMagic;
  config: LatexProjectConfig;
}

/** 解析失败：候选清单给模型/界面看，detail 是一句人话 */
export interface LatexPlanFailure {
  status: "no-main-file";
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
  const magic: LatexMagic = { program: null, root: null, options: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("%")) break;
    const match = /^%\s*!TEX\s+(program|root|options)\s*=\s*(.*)$/i.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = unquote((match[2] ?? "").trim());
    if (value === "") continue;
    if (key === "program") magic.program = magicProgram(value);
    else if (key === "root") magic.root = value;
    else magic.options = splitOptions(value);
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

/** 解析 `.orbita/latex.json` 的内容；坏值逐项丢弃（返回值永远是合法对象） */
export function parseProjectConfig(raw: unknown): LatexProjectConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const config: LatexProjectConfig = {};
  const main = nonEmpty(record["main"]);
  if (main !== undefined) config.main = main;
  if (isLatexEngine(record["engine"])) config.engine = record["engine"];
  const outDir = nonEmpty(record["outDir"]);
  if (outDir !== undefined) config.outDir = outDir;
  const args = stringList(record["args"]);
  if (args !== undefined) config.args = args;
  const recipe = stringList(record["recipe"]);
  if (recipe !== undefined) config.recipe = recipe;
  // 非布尔（"true" / 1）当作没写：开关状态显示与实际行为不能分家（同 settings 的纪律）
  if (typeof record["compileOnSave"] === "boolean") config.compileOnSave = record["compileOnSave"];
  return config;
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

/** 主文件解析。deps 只为测试留的：默认就查真盘 */
export interface LatexResolveDeps {
  exists(path: string): boolean;
  read(path: string): string;
  list(dir: string): string[];
}

const realFs: LatexResolveDeps = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf8"),
  list: (dir) => readdirSync(dir),
};

/**
 * 从请求 + 目录内容解析出完整计划。**不 spawn、不写盘**。
 * `request` 里的 main / engine 来自 agent 工具或 renderer（显式意愿）。
 */
export function resolveLatexPlan(
  dirInput: string,
  request: LatexResolveRequest,
  deps: LatexResolveDeps = realFs,
): LatexResolution {
  const dir = resolve(dirInput);
  const config = readProjectConfigWith(deps, dir);
  const found = findMainFile(dir, request.main ?? config.main, deps);
  if (!found.ok) return { status: "no-main-file", dir, ...found };

  let mainPath = found.path;
  let workDir = dirname(mainPath);
  let magic = readMagic(deps, mainPath);

  /*
   * `% !TEX root = ../thesis.tex`：当前文件是被 \input 的子文档，真正的主文件在别处。
   * 只跟一跳——root 指回自己、或链式 root（A→B→C）都是坏配置，跟一跳即可让
   * latexmk 编对东西，再跟下去只会打转。工作目录随之变成新主文件的目录。
   */
  if (magic.root !== null) {
    const rooted = isAbsolute(magic.root) ? resolve(magic.root) : resolve(workDir, magic.root);
    if (!deps.exists(rooted) || !isFile(deps, rooted)) {
      return {
        status: "no-main-file",
        dir,
        candidates: [found.name],
        detail: `${found.name} points at its main file with "% !TEX root = ${magic.root}", but ${rooted} does not exist.`,
      };
    }
    mainPath = rooted;
    workDir = dirname(mainPath);
    magic = readMagic(deps, mainPath);
  }

  const mainName = relativeName(workDir, mainPath);
  const outDir = resolve(workDir, config.outDir ?? LATEX_DEFAULT_OUT_DIR);
  const source = readText(deps, mainPath);
  const picked = pickEngine(request.engine, magic.program, config.engine, source);
  const built = buildArgv({
    config,
    magic,
    mainName,
    dir: workDir,
    outDir,
    engine: picked.engine,
  });

  return {
    status: "ok",
    dir: workDir,
    mainPath,
    mainName,
    outDir,
    engine: picked.engine,
    engineSource: picked.source,
    command: built.command,
    argv: built.argv,
    magic,
    config,
  };
}

function readProjectConfigWith(deps: LatexResolveDeps, dir: string): LatexProjectConfig {
  const path = join(dir, LATEX_CONFIG_PATH);
  if (!deps.exists(path)) return {};
  try {
    return parseProjectConfig(JSON.parse(deps.read(path)) as unknown);
  } catch (cause) {
    console.warn(`[latex] 读不了 ${path}，按没有配置处理：`, cause);
    return {};
  }
}

function readMagic(deps: LatexResolveDeps, mainPath: string): LatexMagic {
  return parseMagicComments(readText(deps, mainPath));
}

function readText(deps: LatexResolveDeps, path: string): string {
  try {
    return deps.read(path);
  } catch (cause) {
    console.warn(`[latex] 读不了 ${path}：`, cause);
    return "";
  }
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

function relativeName(dir: string, path: string): string {
  // 用 path.relative 而不是 startsWith + slice：`C:\a\b` 与 `C:\a\bc\main.tex`
  // 的前缀判断会切出 `c\main.tex`（评审 A9）。切不出来的（真的不在 dir 下）
  // 退回绝对路径，交给 latexmk 自己报错。
  const rel = relative(dir, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

type MainLookup =
  | { ok: true; path: string; name: string }
  | { ok: false; candidates: string[]; detail: string };

/**
 * 按优先级找主文件。**显式给的路径不存在时不再回落**：模型说「编 paper.tex」，
 * 我们悄悄去编 main.tex，它拿到的 PDF 与它以为的不是同一份。
 */
function findMainFile(
  dir: string,
  explicit: string | undefined,
  deps: LatexResolveDeps,
): MainLookup {
  if (explicit !== undefined) {
    const path = isAbsolute(explicit) ? resolve(explicit) : resolve(dir, explicit);
    if (extname(path).toLowerCase() !== ".tex") {
      return {
        ok: false,
        candidates: listTexFiles(dir, deps),
        detail: `The main file must be a .tex file (got ${path}).`,
      };
    }
    if (deps.exists(path) && isFile(deps, path)) return { ok: true, path, name: relativeName(dir, path) };
    return {
      ok: false,
      candidates: listTexFiles(dir, deps),
      detail: `The requested main file ${path} does not exist.`,
    };
  }
  const conventional = join(dir, "main.tex");
  if (deps.exists(conventional)) {
    return { ok: true, path: conventional, name: "main.tex" };
  }
  const texFiles = listTexFiles(dir, deps);
  if (texFiles.length === 1) {
    const only = texFiles[0] ?? "";
    return { ok: true, path: join(dir, only), name: only };
  }
  return {
    ok: false,
    candidates: texFiles,
    detail:
      texFiles.length === 0
        ? `No .tex file in ${dir}.`
        : `${dir} has ${texFiles.length} .tex files and no main.tex — pass main to say which one to compile.`,
  };
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

function pickEngine(
  requested: LatexEngine | undefined,
  magic: LatexEngine | null,
  configured: LatexEngine | undefined,
  source: string,
): { engine: LatexEngine; source: LatexPlan["engineSource"] } {
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
  config: LatexProjectConfig;
  magic: LatexMagic;
  /** 主文件名（相对 dir） */
  mainName: string;
  dir: string;
  outDir: string;
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
 * -outdir=<abs> <main>`
 *
 * - `recipe` 给了就完全照它来：**recipe[0] 是可执行文件**，`recipe.slice(1)` 是参数，
 *   占位符只在参数里展开。这正是「整条命令」的字面语义（评审 M1：以前把
 *   recipe[0] 也当参数传给 latexmk，写 `["latexmk", …]` 的配置必挂）。
 * - `args` / magic options 叠在默认参数之后、主文件名之前（latexmk 的选项都在文件前）。
 * - outdir 用**绝对路径**：magic root 会把工作目录改到别处，相对路径的含义
 *   随 cwd 漂移。run.ts 先按 outDir 找 log/pdf，找不到再回退到主文件目录与
 *   日志里的 `Output written on`（自定义 recipe 可以不带 -outdir）。
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
