/**
 * 插件目录扫描：读清单（可选）、按默认位置与清单声明找技能与 MCP、把不支持的组件列出来。
 *
 * **纯读盘，不执行任何东西**：安装前预览与开轮装配都走这一份，所以「用户确认时看到的」
 * 与「开轮时真正加载的」是同一套解析。规格对照 Claude Code 的 plugins manifest reference：
 *
 * - 清单按顺序认 `.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json`；没有清单也行，
 *   名字退回目录名；
 * - 技能：默认 `skills/` 目录 + 清单 `skills`（路径或数组，`"."` = 插件根）。目录里要么每个
 *   子文件夹一个 `SKILL.md`，要么这个文件夹本身就是一条技能；插件根有 `SKILL.md` 且既没有
 *   `skills/` 也没写 `skills` 时整个插件就是一条技能；
 * - MCP：根目录 `.mcp.json` 先读，再按清单 `mcpServers` 的顺序（路径 / 内联表 / 数组），
 *   后声明的同名替换先声明的；
 * - 路径必须落在插件根之内且存在：含 `..` 段、绝对路径、符号链接指到根外的一律不加载并报问题。
 *   **宽容一处**：规格要求以 `./` 开头，但 ZCode 官方清单写的是 `"skills": "skills"`，
 *   第二期市场要装它们，所以不带 `./` 的相对路径照认（含 `..` 与逃逸的仍拒绝）。
 *
 * 清单里 Orbita 自己的扩展 `orbita.workflow`（给人看的步骤列表）见 workflow.ts。
 *
 * 其余组件（commands / agents / hooks / lsp / 输出风格 / monitors / bin / 面板 / channels …）
 * 解析出名字列进 `unsupported`，不加载、但不静默丢。
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { isNotFound } from "../fs-errors.ts";
import { parseSkillMd } from "../skill/store.ts";
import { parseServer, type McpServer } from "../../shared/mcp.ts";
import { parseWorkflow } from "./workflow.ts";
import {
  isPluginName,
  PLUGIN_MANIFEST_PATHS,
  type PluginConfigField,
  type PluginConfigType,
  type PluginConfigValue,
  type PluginProblem,
  type PluginUnsupported,
  type PluginUnsupportedKind,
  type PluginWorkflowStep,
} from "../../shared/plugin.ts";

/** 清单 `orbita` 对象里认识的子键（约定见 shared/plugin.ts）；别的列进「暂不支持」。 */
const ORBITA_KNOWN_KEYS = ["workflow", "panel"];

/** 「暂不支持」里每类最多列几个名字（数量以 count 为准）。 */
const UNSUPPORTED_ITEMS_MAX = 6;

const SKILL_FILE = "SKILL.md";

export interface DiscoveredSkill {
  slug: string;
  name: string;
  description: string;
  /** 技能目录（传给 pi 的 additionalSkillPaths 的就是它：目录里有 SKILL.md，pi 当技能根，不再往下递归） */
  dir: string;
  file: string;
}

export interface ScannedMcpServer {
  /** 清单 / .mcp.json 里的服务名 */
  name: string;
  /** 解析成功的规范形状（已剥掉 workspaces / disabled：范围由插件的启用范围说了算）；认不出为 null */
  server: McpServer | null;
  /** server 为 null 时的原因代码（`unsupported-shape`：不是 stdio 的 command 或 http 的 url 配置，SSE / WebSocket 不支持） */
  invalid: string | null;
}

export interface ScannedPlugin {
  /** 清单 name；没有就用目录名（小写化）。不一定合法，见 nameValid */
  name: string;
  nameValid: boolean;
  displayName: string;
  version: string | null;
  description: string;
  author: string | null;
  license: string | null;
  manifestFile: string | null;
  config: PluginConfigField[];
  skills: DiscoveredSkill[];
  /** 清单 `orbita.workflow`：给人看的步骤（没写为空数组） */
  workflow: PluginWorkflowStep[];
  mcpServers: ScannedMcpServer[];
  unsupported: PluginUnsupported[];
  hasScripts: boolean;
  problems: PluginProblem[];
  /** 找到了清单或任何已知组件：全空说明这不是个插件目录 */
  foundAnything: boolean;
}

/** 扫描一个插件根。`fallbackName`：没有清单（或清单没写 name）时用的名字，通常是目录名。 */
export async function scanPlugin(root: string, fallbackName: string): Promise<ScannedPlugin> {
  const realRoot = await realpath(root);
  const problems: PluginProblem[] = [];

  const { manifest, manifestFile } = await readManifest(root, problems);
  const rawName = typeof manifest["name"] === "string" && manifest["name"] !== "" ? manifest["name"] : fallbackName.toLowerCase();
  const author = readAuthor(manifest["author"]);

  const skills = await discoverSkills(root, realRoot, rawName, manifest, problems);
  const mcpServers = await discoverMcp(root, realRoot, manifest, problems);
  const unsupported = await detectUnsupported(root, manifest, mcpServers.bundles);
  const hasScripts = await isDirectory(join(root, "scripts"));

  return {
    name: rawName,
    nameValid: isPluginName(rawName),
    displayName: typeof manifest["displayName"] === "string" && manifest["displayName"] !== "" ? manifest["displayName"] : rawName,
    version: typeof manifest["version"] === "string" && manifest["version"] !== "" ? manifest["version"] : null,
    description: typeof manifest["description"] === "string" ? manifest["description"] : "",
    author,
    license: typeof manifest["license"] === "string" && manifest["license"] !== "" ? manifest["license"] : null,
    manifestFile,
    config: parseUserConfig(manifest["userConfig"], problems),
    skills,
    workflow: parseWorkflow(manifest, skills, problems),
    mcpServers: mcpServers.servers,
    unsupported,
    hasScripts,
    problems,
    foundAnything:
      manifestFile !== null || skills.length > 0 || mcpServers.servers.length > 0 || unsupported.length > 0 || hasScripts,
  };
}

// ---------- 清单 ----------

async function readManifest(
  root: string,
  problems: PluginProblem[],
): Promise<{ manifest: Record<string, unknown>; manifestFile: string | null }> {
  for (const relative of PLUGIN_MANIFEST_PATHS) {
    const file = join(root, ...relative.split("/"));
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      problems.push({ kind: "manifest-unreadable", detail: `${relative}: ${errorMessage(error)}` });
      return { manifest: {}, manifestFile: relative };
    }
    try {
      const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        problems.push({ kind: "manifest-invalid", detail: `${relative}: top level is not an object` });
        return { manifest: {}, manifestFile: relative };
      }
      return { manifest: parsed as Record<string, unknown>, manifestFile: relative };
    } catch (error) {
      // 清单写坏了：按没有清单继续（默认位置照扫），但如实报——静默按默认加载会让人以为清单生效了
      problems.push({ kind: "manifest-invalid", detail: `${relative}: ${errorMessage(error)}` });
      return { manifest: {}, manifestFile: relative };
    }
  }
  return { manifest: {}, manifestFile: null };
}

/** author 可以是 `{ name, email, url }` 或一个字符串。 */
function readAuthor(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "object" && value !== null) {
    const name = (value as Record<string, unknown>)["name"];
    if (typeof name === "string" && name !== "") return name;
  }
  return null;
}

// ---------- userConfig ----------

const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIG_TYPES: readonly PluginConfigType[] = ["string", "number", "boolean", "directory", "file"];

/**
 * 配置项解析。规格里 title / description 必填，但 ZCode 官方清单只写 type / default /
 * description，所以缺省值宽容地补（title 退回键名）；键名不合法的一条跳过并报，不拖累其它。
 */
export function parseUserConfig(raw: unknown, problems: PluginProblem[] = []): PluginConfigField[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const fields: PluginConfigField[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!CONFIG_KEY.test(key)) {
      problems.push({ kind: "config-key-invalid", detail: key });
      continue;
    }
    const entry = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const type = CONFIG_TYPES.find((each) => each === entry["type"]) ?? "string";
    const options = Array.isArray(entry["options"])
      ? entry["options"].filter((item): item is string => typeof item === "string" && item !== "")
      : [];
    fields.push({
      key,
      type,
      title: typeof entry["title"] === "string" && entry["title"] !== "" ? entry["title"] : key,
      description: typeof entry["description"] === "string" ? entry["description"] : "",
      required: entry["required"] === true,
      sensitive: entry["sensitive"] === true,
      default: configDefault(entry["default"]),
      options: type === "string" && options.length > 0 ? options : null,
      multiple: type === "string" && entry["multiple"] === true,
      min: typeof entry["min"] === "number" && Number.isFinite(entry["min"]) ? entry["min"] : null,
      max: typeof entry["max"] === "number" && Number.isFinite(entry["max"]) ? entry["max"] : null,
    });
  }
  return fields;
}

function configDefault(value: unknown): PluginConfigValue | null {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return value;
  return null;
}

// ---------- 路径 ----------

type ResolvedPath = { ok: true; abs: string } | { ok: false; problem: PluginProblem };

/**
 * 清单里的组件路径 → 绝对路径。含 `..`、绝对路径、盘符一律当逃逸；落盘后再 realpath 一次，
 * 符号链接指到根外的也拒（`realRoot` 是根的 realpath，比较在规范形上做）。
 * 前导 `./` 可有可无（见文件头：为 ZCode 官方清单宽容）；`.` 与 `./` 都是插件根。
 */
export async function resolveComponentPath(
  root: string,
  realRoot: string,
  field: string,
  raw: string,
): Promise<ResolvedPath> {
  const escape: ResolvedPath = { ok: false, problem: { kind: "path-escape", detail: `${field}: ${raw}` } };
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\")) return escape;
  const segments = raw.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return escape;
  const abs = join(root, ...segments);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (error) {
    if (isNotFound(error)) return { ok: false, problem: { kind: "path-missing", detail: `${field}: ${raw}` } };
    throw error;
  }
  if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return escape;
  return { ok: true, abs };
}

/** 路径字段的形状：一个字符串或字符串数组；别的形状忽略（并不报：属于「清单里写了我们不认的东西」）。 */
function stringList(value: unknown): string[] {
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item !== "");
  return [];
}

// ---------- 技能 ----------

async function discoverSkills(
  root: string,
  realRoot: string,
  /** 插件根本身是技能时的 slug：取插件名（目录名随装法而变，名字不变） */
  rootSlug: string,
  manifest: Record<string, unknown>,
  problems: PluginProblem[],
): Promise<DiscoveredSkill[]> {
  const roots: string[] = [];
  const defaultDir = join(root, "skills");
  const hasDefault = await isDirectory(defaultDir);
  const declared = stringList(manifest["skills"]);
  if (hasDefault) {
    // 默认目录自己也可能是符号链接指到根外（链接安装的用户目录里可能有）：同样过一遍逃逸检查
    const checked = await resolveComponentPath(root, realRoot, "skills", "skills");
    if (checked.ok) roots.push(checked.abs);
    else problems.push(checked.problem);
  }
  for (const entry of declared) {
    const checked = await resolveComponentPath(root, realRoot, "skills", entry);
    if (!checked.ok) {
      problems.push(checked.problem);
      continue;
    }
    if (!(await isDirectory(checked.abs))) {
      problems.push({ kind: "path-missing", detail: `skills: ${entry} (not a directory)` });
      continue;
    }
    roots.push(checked.abs);
  }
  // 插件根本身就是一条技能：没有 skills/ 也没写 skills，根上有 SKILL.md
  if (!hasDefault && declared.length === 0 && (await isFile(join(root, SKILL_FILE)))) roots.push(root);

  const skills: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const dir of roots) {
    for (const skillDir of await skillDirsIn(dir, realRoot, problems)) {
      const real = await realpath(skillDir).catch(() => skillDir);
      if (seen.has(real)) continue;
      seen.add(real);
      const skill = await readSkill(skillDir, root, rootSlug, problems);
      if (skill !== null) skills.push(skill);
    }
  }
  // 顺序稳定：skill 索引进 system prompt，顺序一抖整条 prefix 缓存就作废（同 SkillStore.list 的理由）
  return skills.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** 一个技能根目录里的技能文件夹：自己有 SKILL.md 就是它自己；否则一层子文件夹里有 SKILL.md 的。 */
async function skillDirsIn(dir: string, realRoot: string, problems: PluginProblem[]): Promise<string[]> {
  if (await isFile(join(dir, SKILL_FILE))) return [dir];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    problems.push({ kind: "path-missing", detail: `${dir}: ${errorMessage(error)}` });
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const sub = join(dir, name);
    if (!(await isDirectory(sub))) continue;
    // 子文件夹是符号链接指到根外：不加载（与清单路径同一条规则）
    const real = await realpath(sub).catch(() => null);
    if (real === null) continue;
    if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
      problems.push({ kind: "path-escape", detail: `skills/${name}` });
      continue;
    }
    if (await isFile(join(sub, SKILL_FILE))) out.push(sub);
  }
  return out;
}

async function readSkill(
  dir: string,
  root: string,
  rootSlug: string,
  problems: PluginProblem[],
): Promise<DiscoveredSkill | null> {
  const file = join(dir, SKILL_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    problems.push({ kind: "skill-unreadable", detail: `${file}: ${errorMessage(error)}` });
    return null;
  }
  const slug = dir === root ? rootSlug : basename(dir);
  const parsed = parseSkillMd(raw);
  const description = parsed.description?.trim() ?? "";
  // pi 没有 description 的 SKILL.md 不会加载（skills.js：hasDescription 为假时返回 null）。
  // 列进「里面有什么」却不生效比不列更糟——报出来，不当技能数
  if (description === "") {
    problems.push({ kind: "skill-no-description", detail: dir === root ? SKILL_FILE : `${slug}/${SKILL_FILE}` });
    return null;
  }
  return { slug, name: parsed.name !== null && parsed.name !== "" ? parsed.name : slug, description, dir, file };
}

// ---------- MCP ----------

interface DiscoveredMcp {
  servers: ScannedMcpServer[];
  /** `.mcpb` / `.dxt` 包与 https 包地址：不支持，交给 unsupported */
  bundles: string[];
}

/**
 * `.mcp.json` 先读，再按清单 `mcpServers` 声明的顺序；同名后者替换前者（保持首次出现的位置，
 * 让列表顺序稳定）。文件里既可以是 `{ "mcpServers": {...} }` 也可以直接是名字 → 配置的表。
 */
async function discoverMcp(
  root: string,
  realRoot: string,
  manifest: Record<string, unknown>,
  problems: PluginProblem[],
): Promise<DiscoveredMcp> {
  const byName = new Map<string, ScannedMcpServer>();
  const bundles: string[] = [];
  const add = (table: unknown): void => {
    for (const [name, raw] of Object.entries(mcpTable(table))) {
      const parsed = parseServer(raw);
      byName.set(
        name,
        parsed === null
          ? { name, server: null, invalid: "unsupported-shape" }
          : { name, server: stripPluginScope(parsed), invalid: null },
      );
    }
  };
  const addFile = async (relative: string, field: string): Promise<void> => {
    const checked = await resolveComponentPath(root, realRoot, field, relative);
    if (!checked.ok) {
      problems.push(checked.problem);
      return;
    }
    try {
      add(JSON.parse(await readFile(checked.abs, "utf8")));
    } catch (error) {
      problems.push({ kind: "mcp-unreadable", detail: `${relative}: ${errorMessage(error)}` });
    }
  };

  if (await isFile(join(root, ".mcp.json"))) await addFile(".mcp.json", ".mcp.json");
  const declared = manifest["mcpServers"];
  const items = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
  for (const item of items) {
    if (typeof item === "string") {
      if (/^https?:\/\//.test(item) || /\.(mcpb|dxt)$/i.test(item)) bundles.push(item);
      else await addFile(item, "mcpServers");
    } else {
      add(item);
    }
  }
  return { servers: [...byName.values()], bundles };
}

/** `{ mcpServers: {...} }` 或直接的名字表；不是对象就是空。 */
function mcpTable(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const wrapped = (value as Record<string, unknown>)["mcpServers"];
  if (typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)) return wrapped as Record<string, unknown>;
  return value as Record<string, unknown>;
}

/** 插件里的 server 不自带范围与停用：它们由插件的启用范围统一管（否则同一件事有两个开关）。 */
function stripPluginScope(server: McpServer): McpServer {
  const copy: McpServer = { ...server };
  delete copy.workspaces;
  delete copy.disabled;
  return copy;
}

// ---------- 暂不支持的组件 ----------

async function detectUnsupported(
  root: string,
  manifest: Record<string, unknown>,
  bundles: readonly string[],
): Promise<PluginUnsupported[]> {
  const out: PluginUnsupported[] = [];
  const push = (kind: PluginUnsupportedKind, names: string[]): void => {
    const unique = [...new Set(names)];
    out.push({ kind, items: unique.slice(0, UNSUPPORTED_ITEMS_MAX), count: unique.length });
  };
  const experimental = isRecord(manifest["experimental"]) ? manifest["experimental"] : {};

  // 命令：清单对象表的键、路径指向的 .md、默认 commands/ 目录
  const commands = [...mapKeys(manifest["commands"]), ...(await namesAt(root, manifest["commands"], ".md")), ...(await dirNames(root, "commands", ".md"))];
  if (manifest["commands"] !== undefined || (await isDirectory(join(root, "commands")))) push("commands", commands);

  const agents = [...(await namesAt(root, manifest["agents"], ".md")), ...(await dirNames(root, "agents", ".md"))];
  if (manifest["agents"] !== undefined || (await isDirectory(join(root, "agents")))) push("agents", agents);

  const hooks = await hookEvents(root, manifest["hooks"]);
  if (manifest["hooks"] !== undefined || (await isFile(join(root, "hooks", "hooks.json")))) push("hooks", hooks);

  const lsp = [...mapKeys(manifest["lspServers"]), ...(await jsonMapKeys(join(root, ".lsp.json")))];
  if (manifest["lspServers"] !== undefined || (await isFile(join(root, ".lsp.json")))) push("lsp", lsp);

  const styles = [...(await namesAt(root, manifest["outputStyles"])), ...(await dirNames(root, "output-styles"))];
  if (manifest["outputStyles"] !== undefined || (await isDirectory(join(root, "output-styles")))) push("output-styles", styles);

  const monitorsValue = experimental["monitors"] ?? manifest["monitors"];
  const monitorFile = join(root, "monitors", "monitors.json");
  if (monitorsValue !== undefined || (await isFile(monitorFile))) {
    const inline = Array.isArray(monitorsValue) ? monitorsValue.map(nameOfEntry) : [];
    push("monitors", [...inline, ...(await jsonArrayNames(monitorFile))].filter((name): name is string => name !== null));
  }

  if (await isDirectory(join(root, "bin"))) push("bin", await dirNames(root, "bin"));

  // 面板：ZCode 清单的 ui.surfaces（面板依赖宿主进程，Orbita 里不显示）
  const surfaces = isRecord(manifest["ui"]) && Array.isArray(manifest["ui"]["surfaces"]) ? manifest["ui"]["surfaces"] : null;
  if (surfaces !== null) push("panel", surfaces.map(nameOfEntry).filter((name): name is string => name !== null));

  if (Array.isArray(manifest["channels"])) {
    push("channels", manifest["channels"].map((entry) => (isRecord(entry) && typeof entry["server"] === "string" ? entry["server"] : null)).filter((name): name is string => name !== null));
  }

  const workflows = [...(await namesAt(root, manifest["workflows"])), ...(await dirNames(root, "workflows"))];
  if (manifest["workflows"] !== undefined || (await isDirectory(join(root, "workflows")))) push("workflows", workflows);

  const themesValue = experimental["themes"] ?? manifest["themes"];
  const themes = [...(await namesAt(root, themesValue)), ...(await dirNames(root, "themes"))];
  if (themesValue !== undefined || (await isDirectory(join(root, "themes")))) push("themes", themes);

  if (manifest["settings"] !== undefined || (await isFile(join(root, "settings.json")))) push("settings", []);

  if (bundles.length > 0) push("mcp-bundle", bundles.map((bundle) => basename(bundle)));

  // Orbita 自己的清单扩展：只认 workflow 与 panel，其余子键列出来不静默丢
  const unknownOrbita = isRecord(manifest["orbita"]) ? Object.keys(manifest["orbita"]).filter((key) => !ORBITA_KNOWN_KEYS.includes(key)) : [];
  if (unknownOrbita.length > 0) push("orbita", unknownOrbita);

  if (Array.isArray(manifest["dependencies"]) && manifest["dependencies"].length > 0) {
    push("dependencies", manifest["dependencies"].map((entry) => (typeof entry === "string" ? entry : nameOfEntry(entry))).filter((name): name is string => name !== null));
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameOfEntry(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  for (const key of ["id", "name", "title"]) {
    if (typeof entry[key] === "string" && entry[key] !== "") return entry[key];
  }
  return null;
}

/** 对象表的键（commands 的对象写法、lspServers 的内联写法）；数组 / 字符串不是表。 */
function mapKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

/** 清单里的路径（字符串或数组）指向的文件 / 目录里的名字：文件取去后缀的名，目录列其中条目。 */
async function namesAt(root: string, value: unknown, extension?: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of stringList(value)) {
    const segments = entry.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
    if (isAbsolute(entry) || segments.includes("..")) continue;
    const abs = join(root, ...segments);
    if (await isDirectory(abs)) names.push(...(await listNames(abs, extension)));
    else if (await isFile(abs)) names.push(stripExtension(basename(abs)));
  }
  return names;
}

async function dirNames(root: string, dir: string, extension?: string): Promise<string[]> {
  return listNames(join(root, dir), extension);
}

async function listNames(dir: string, extension?: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith(".") && (extension === undefined || name.endsWith(extension)))
    .sort()
    .map(stripExtension);
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

async function hookEvents(root: string, value: unknown): Promise<string[]> {
  const events: string[] = [];
  const fromObject = (object: unknown): void => {
    if (!isRecord(object)) return;
    const inner = isRecord(object["hooks"]) ? object["hooks"] : object;
    events.push(...Object.keys(inner));
  };
  const sources = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const source of sources) {
    if (typeof source === "string") events.push(...(await jsonMapKeys(join(root, ...source.split(/[\\/]+/).filter((s) => s !== "" && s !== ".")), "hooks")));
    else fromObject(source);
  }
  events.push(...(await jsonMapKeys(join(root, "hooks", "hooks.json"), "hooks")));
  return events;
}

/** 读一个 JSON 文件的对象键（可先下钻一层 `inner`）；读不出来 / 不是对象给空。 */
async function jsonMapKeys(file: string, inner?: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const target = inner !== undefined && isRecord(parsed) && isRecord(parsed[inner]) ? parsed[inner] : parsed;
    return isRecord(target) ? Object.keys(target) : [];
  } catch {
    return [];
  }
}

async function jsonArrayNames(file: string): Promise<(string | null)[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed.map(nameOfEntry) : [];
  } catch {
    return [];
  }
}

// ---------- 小工具 ----------

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
