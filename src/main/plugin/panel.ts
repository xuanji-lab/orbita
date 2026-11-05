/**
 * 插件面板的解析与读写（纯函数 + 文件读写，不碰 Electron）：清单 `orbita.panel` 的字段、
 * 模板与数据路径的校验与变量替换、数据文件读取、动作日志的追加与限速。
 *
 * **模板是不可信输入**（agent 生成或第三方插件带来），所以：
 * - 模板路径走与其它组件路径同一条规则（`resolveComponentPath`：含 `..`、绝对路径、符号链接逃逸一律拒）；
 * - 数据路径要过变量替换，替换结果还必须落在「插件根 / 插件数据目录 / 工作区根 / 引用到的 directory 或
 *   file 型配置值」之内（realpath 再比一次，符号链接指到外面的也拒）——否则一个 `data: "~/.ssh/x"`
 *   就能让宿主把任意 JSON 文件发进模板；
 * - 数据文件超 2 MB 不读（JSON 没法安全截断）；
 * - 动作日志有整份上限与限速，模板失控也写不满磁盘。
 *
 * 清单里还有两个可选的辅助文件：`spec`（模板说明，markdown，宿主渲染）与 `sample`（样例数据，
 * 数据文件不存在 / 为空时用它渲染）。路径规则同模板，读不出来只是少一块、不拦面板。
 */
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNotFound, errorCode } from "../fs-errors.ts";
import type { PluginConfigField, PluginConfigValue } from "../../shared/plugin.ts";
import {
  PANEL_ACTIONS_FILE_MAX_BYTES,
  PANEL_DATA_MAX_BYTES,
  PANEL_SPEC_MAX_BYTES,
  PANEL_TEMPLATE_MAX_BYTES,
  type PluginPanelData,
  type PluginPanelDataProblem,
  type PluginPanelProblem,
} from "../../shared/plugin-panel.ts";
import { resolveComponentPath } from "./manifest.ts";
import { DATA_NAMES, PROJECT_NAMES, ROOT_NAMES } from "./vars.ts";

// ---------- 清单 ----------

export interface PanelSpec {
  title: string;
  /** 清单原文（相对插件根） */
  template: string;
  /** 清单原文（含变量） */
  data: string;
  /** 模板说明 / 样例数据的清单原文（相对插件根）；没写为 null */
  spec: string | null;
  sample: string | null;
}

export interface PanelParse {
  /** 清单里有没有 `orbita.panel`（没有 = 插件不带面板，不报问题） */
  declared: boolean;
  spec: PanelSpec | null;
  /** 让面板整个出不来的问题（spec 为 null 时才有） */
  problems: PluginPanelProblem[];
  /** 不拦面板的问题：spec / sample 写成了不认识的形状 */
  notices: PluginPanelProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读清单里的 `orbita.panel`。title 缺省退回插件显示名（宽容：标题不是安全相关字段）；
 * template 与 data 必填，缺了 / 类型不对报 `shape` 并不给 spec。
 */
export function parsePanelSpec(manifest: Record<string, unknown>, fallbackTitle: string): PanelParse {
  const orbita = manifest["orbita"];
  if (!isRecord(orbita) || orbita["panel"] === undefined) return { declared: false, spec: null, problems: [], notices: [] };
  const panel = orbita["panel"];
  if (!isRecord(panel)) return { declared: true, spec: null, problems: [{ kind: "shape", detail: "panel" }], notices: [] };
  const problems: PluginPanelProblem[] = [];
  const template = panel["template"];
  const data = panel["data"];
  if (typeof template !== "string" || template.trim() === "") problems.push({ kind: "shape", detail: "template" });
  if (typeof data !== "string" || data.trim() === "") problems.push({ kind: "shape", detail: "data" });
  if (problems.length > 0) return { declared: true, spec: null, problems, notices: [] };
  const title = typeof panel["title"] === "string" && panel["title"].trim() !== "" ? panel["title"].trim() : fallbackTitle;
  const notices: PluginPanelProblem[] = [];
  const optionalPath = (field: "spec" | "sample"): string | null => {
    const value = panel[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim() === "") {
      notices.push({ kind: "shape", detail: field });
      return null;
    }
    return value.trim();
  };
  const specPath = optionalPath("spec");
  const samplePath = optionalPath("sample");
  return {
    declared: true,
    spec: { title, template: (template as string).trim(), data: (data as string).trim(), spec: specPath, sample: samplePath },
    problems: [],
    notices,
  };
}

// ---------- 路径 ----------

export interface PanelPathContext {
  /** 插件根（`${CLAUDE_PLUGIN_ROOT}`） */
  root: string;
  /** 插件数据目录（`${CLAUDE_PLUGIN_DATA}`，动作日志也在这里） */
  dataDir: string;
  fields: readonly PluginConfigField[];
  /** 已存的非敏感配置值（敏感项根本不允许进数据路径，所以这里不需要密钥库的值） */
  values: Readonly<Record<string, PluginConfigValue>>;
  /** 会话所在工作区根；Home 会话为 null */
  workspaceRoot: string | null;
}

export type ResolvedDataPath = { ok: true; path: string } | { ok: false; problem: PluginPanelProblem };

const VARIABLE = /\$\{([^}]*)\}/g;

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 路径可能还不存在（数据文件第一轮之前没有）：对最近的存在的祖先取 realpath，再把没存在的尾巴接回去。 */
async function realpathLoose(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch (error) {
      if (!isNotFound(error) && errorCode(error) !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * `data` 路径：先替换变量，再要求落在允许的目录之内。
 * 认的变量：`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`（`ZCODE_` 前缀同义）、`${user_config.KEY}`、
 * `${workspaceFolder}`（`CLAUDE_PROJECT_DIR` 同义）。认不得的变量原样报 `data-variable`，不猜值；
 * 敏感配置项拒绝（路径会出现在详情页与日志里）；必填配置没填报 `data-config-missing`。
 * 相对路径按插件根解析。
 */
export async function resolveDataPath(raw: string, context: PanelPathContext): Promise<ResolvedDataPath> {
  const allowed: string[] = [context.root, context.dataDir];
  if (context.workspaceRoot !== null) allowed.push(context.workspaceRoot);
  let problem: PluginPanelProblem | null = null;
  const fail = (found: PluginPanelProblem): string => {
    problem ??= found;
    return "";
  };
  const substituted = raw.replace(VARIABLE, (_whole, rawName: string) => {
    const name = rawName.trim();
    if (ROOT_NAMES.has(name)) return context.root;
    if (DATA_NAMES.has(name)) return context.dataDir;
    if (name === "workspaceFolder" || PROJECT_NAMES.has(name)) {
      return context.workspaceRoot ?? fail({ kind: "data-needs-workspace", detail: name });
    }
    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      const field = context.fields.find((each) => each.key === key);
      if (field === undefined) return fail({ kind: "data-variable", detail: name });
      if (field.sensitive) return fail({ kind: "data-sensitive", detail: key });
      const actual = context.values[key] ?? field.default;
      if (actual === null || actual === undefined || actual === "") return fail({ kind: "data-config-missing", detail: key });
      const text = Array.isArray(actual) ? actual.join(",") : String(actual);
      // 用户亲手选的目录 / 文件：它所在的位置也算允许（数据不一定非得放在插件或工作区里）
      if ((field.type === "directory" || field.type === "file") && typeof actual === "string" && isAbsolute(actual)) allowed.push(actual);
      return text;
    }
    return fail({ kind: "data-variable", detail: name });
  });
  if (problem !== null) return { ok: false, problem };
  if (substituted.trim() === "" || substituted.includes("\u0000")) return { ok: false, problem: { kind: "data-escape", detail: substituted } };

  const path = resolve(context.root, substituted);
  const outside: PluginPanelProblem = { kind: "data-escape", detail: path };
  // 词法一关：`..` 走出去的在这里就拒
  if (!allowed.some((base) => isInside(resolve(base), path))) return { ok: false, problem: outside };
  // 符号链接一关：路径（或它的祖先）是指到别处的链接，真实位置也得在允许的目录里
  try {
    const real = await realpathLoose(path);
    for (const base of allowed) {
      const realBase = await realpathLoose(resolve(base));
      if (isInside(realBase, real)) return { ok: true, path };
    }
  } catch {
    return { ok: false, problem: outside };
  }
  return { ok: false, problem: outside };
}

// ---------- 模板 ----------

export type PanelFileResult =
  | { ok: true; abs: string; /** mtime:size */ stamp: string }
  | { ok: false; problem: PluginPanelProblem };
/** 保留旧名：模板与另外两个辅助文件走同一条定位规则，返回形状一样 */
export type PanelTemplateResult = PanelFileResult;

/** 三种面板文件各自的问题分类与大小上限。 */
const FILE_KINDS = {
  template: {
    escape: "template-escape",
    missing: "template-missing",
    unreadable: "template-unreadable",
    tooLarge: "template-too-large",
    label: "panel.template",
    maxBytes: PANEL_TEMPLATE_MAX_BYTES,
  },
  spec: {
    escape: "spec-escape",
    missing: "spec-missing",
    unreadable: "spec-unreadable",
    tooLarge: "spec-too-large",
    label: "panel.spec",
    maxBytes: PANEL_SPEC_MAX_BYTES,
  },
  sample: {
    escape: "sample-escape",
    missing: "sample-missing",
    unreadable: "sample-unreadable",
    tooLarge: "sample-too-large",
    label: "panel.sample",
    maxBytes: PANEL_DATA_MAX_BYTES,
  },
} as const;

export type PanelFileField = keyof typeof FILE_KINDS;

function fileProblem(kind: PluginPanelProblem["kind"], detail: string): PluginPanelProblem {
  return { kind, detail } as PluginPanelProblem;
}

/**
 * 面板文件（模板 / 说明 / 样例）的路径解析 + 是文件 + 没超限，返回一个轻量的 stamp（不读内容）。
 * 路径规则同其它组件路径（`resolveComponentPath`）：含 `..`、绝对路径、符号链接逃逸一律拒。
 * 读不了的情况（权限、不是目录……）也以问题返回，不抛——这三个文件里任何一个坏了都不该让轮询报错。
 */
export async function locatePanelFile(root: string, raw: string, field: PanelFileField): Promise<PanelFileResult> {
  const kinds = FILE_KINDS[field];
  try {
    const realRoot = await realpath(root);
    const resolved = await resolveComponentPath(root, realRoot, kinds.label, raw);
    if (!resolved.ok) return { ok: false, problem: fileProblem(resolved.problem.kind === "path-escape" ? kinds.escape : kinds.missing, raw) };
    const info = await stat(resolved.abs);
    if (!info.isFile()) return { ok: false, problem: fileProblem(kinds.unreadable, `${raw}: not a file`) };
    if (info.size > kinds.maxBytes) return { ok: false, problem: fileProblem(kinds.tooLarge, String(info.size)) };
    return { ok: true, abs: resolved.abs, stamp: `${info.mtimeMs}:${info.size}` };
  } catch (error) {
    return { ok: false, problem: fileProblem(kinds.unreadable, `${raw}: ${errorText(error)}`) };
  }
}

/** 模板路径解析（同 locatePanelFile 的 template 档）。 */
export function locatePanelTemplate(root: string, raw: string): Promise<PanelTemplateResult> {
  return locatePanelFile(root, raw, "template");
}

/** 模板说明：读成文本（去 BOM）。定位已经判过大小，这里只读。 */
export async function readPanelSpec(abs: string): Promise<{ ok: true; text: string } | { ok: false; problem: PluginPanelProblem }> {
  try {
    const raw = await readFile(abs, "utf8");
    return { ok: true, text: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw };
  } catch (error) {
    return { ok: false, problem: fileProblem("spec-unreadable", errorText(error)) };
  }
}

/** 样例数据：读法与数据文件一样（≤ 2 MB、合法 JSON、空算没有）；读不出来的原因换成 sample-* 分类。 */
export async function readPanelSample(abs: string): Promise<{ ok: true; data: PluginPanelData } | { ok: false; problem: PluginPanelProblem }> {
  const data = await readPanelData(abs);
  if (data.kind !== "problem") return { ok: true, data };
  const problem = data.problem;
  if (problem.kind === "too-large") return { ok: false, problem: fileProblem("sample-too-large", String(problem.bytes)) };
  if (problem.kind === "invalid-json") return { ok: false, problem: fileProblem("sample-invalid", problem.message) };
  return { ok: false, problem: fileProblem("sample-unreadable", problem.message) };
}

export async function readPanelTemplate(abs: string): Promise<{ ok: true; html: string } | { ok: false; problem: PluginPanelProblem }> {
  try {
    const raw = await readFile(abs, "utf8");
    return { ok: true, html: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw };
  } catch (error) {
    return { ok: false, problem: { kind: "template-unreadable", detail: errorText(error) } };
  }
}

// ---------- 数据 ----------

export interface DataStat {
  /** 路径上有一个文件 */
  exists: boolean;
  updatedAt: number | null;
  bytes: number | null;
  /** 轻量签名（不读内容）：不存在 `missing`，文件 `mtime:size`；不是文件 / 读不了也各有一个值，保证「变了就不同」 */
  signature: string;
}

export async function statDataFile(path: string): Promise<DataStat> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: false, updatedAt: null, bytes: null, signature: "not-a-file" };
    return { exists: true, updatedAt: Math.floor(info.mtimeMs), bytes: info.size, signature: `${info.mtimeMs}:${info.size}` };
  } catch (error) {
    const missing = isNotFound(error) || errorCode(error) === "ENOTDIR";
    return { exists: false, updatedAt: null, bytes: null, signature: missing ? "missing" : `error:${errorCode(error) ?? "unknown"}` };
  }
}

/**
 * 读数据文件。不存在 / 空白 / 顶层是 null、`{}`、`[]` 都算「空」（面板显示空态）；超过 2 MB 不读直接报
 * too-large；JSON 写坏报 invalid-json（agent 非原子地写到一半时会碰到，调用方留着上一份好数据）。
 */
export async function readPanelData(path: string): Promise<PluginPanelData> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isNotFound(error) || errorCode(error) === "ENOTDIR") return { kind: "empty" };
    return { kind: "problem", problem: { kind: "unreadable", message: errorText(error) } };
  }
  if (!info.isFile()) return { kind: "problem", problem: { kind: "unreadable", message: "not a file" } };
  if (info.size > PANEL_DATA_MAX_BYTES) return { kind: "problem", problem: { kind: "too-large", bytes: info.size } };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { kind: "empty" };
    return { kind: "problem", problem: { kind: "unreadable", message: errorText(error) } };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return { kind: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: "problem", problem: { kind: "invalid-json", message: errorText(error).slice(0, 200) } };
  }
  if (isEmptyJson(value)) return { kind: "empty" };
  return { kind: "ready", value, updatedAt: Math.floor(info.mtimeMs) };
}

function isEmptyJson(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/** 详情页「最近产出」的条数：顶层数组的长度，或顶层对象里最长的数组属性的长度；别的形状为 null。 */
export function itemCountOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (!isRecord(value)) return null;
  let best: number | null = null;
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry) && (best === null || entry.length > best)) best = entry.length;
  }
  return best;
}

// ---------- 动作日志 ----------

/** 滑动窗口限速：`key` 在最近 `windowMs` 内最多 `max` 次。时钟可注入。 */
export class ActionLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** 允许就记一次并返回 true；超限返回 false 且不记。 */
  allow(key: string): boolean {
    const at = this.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => at - time < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(at);
    this.hits.set(key, recent);
    return true;
  }
}

/**
 * 追加一行到动作日志。**一次 write 一整行**（`a+` 模式下由 O_APPEND 定位到文件尾，并发追加不会互相穿插），
 * 上一行若因崩溃缺了结尾换行，先补一个，保证每行都是完整的 JSON。整份超过上限拒绝（`file-full`）。
 * 调用方负责串行化（同一文件的追加排队），这里不持锁。
 */
export async function appendActionLine(file: string, line: string, maxBytes: number = PANEL_ACTIONS_FILE_MAX_BYTES): Promise<"ok" | "file-full"> {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "a+");
  try {
    const { size } = await handle.stat();
    let bytes = Buffer.from(`${line}\n`, "utf8");
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) bytes = Buffer.concat([Buffer.from("\n"), bytes]);
    }
    if (size + bytes.length > maxBytes) return "file-full";
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
    if (bytesWritten !== bytes.length) throw new Error(`short write: ${bytesWritten}/${bytes.length}`);
    return "ok";
  } finally {
    await handle.close();
  }
}

/** 动作日志此刻的状态：最后修改时间与条数（非空行）。文件不存在 = 没有；超过 8 MB 不数（条数 null）。 */
export async function readActionsInfo(file: string): Promise<{ updatedAt: number | null; count: number | null }> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (isNotFound(error) || errorCode(error) === "ENOTDIR") return { updatedAt: null, count: 0 };
    throw error;
  }
  if (!info.isFile()) return { updatedAt: null, count: 0 };
  const updatedAt = Math.floor(info.mtimeMs);
  if (info.size > 8 * 1024 * 1024) return { updatedAt, count: null };
  const text = await readFile(file, "utf8");
  return { updatedAt, count: text.split("\n").filter((line) => line.trim() !== "").length };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
