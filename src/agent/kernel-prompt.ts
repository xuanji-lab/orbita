/**
 * 系统提示的基底（璇玑自己写的那一份）与它要的资源：项目说明、技能索引、~/.pi/agent/settings.json 里用到的几项。
 *
 * 发出去的系统提示 = 这里的基底 → adaptSystemPrompt（prompt-narration.ts，接上进度说明）→ 拼上 system-prompt.ts
 * 的各段（orbitaSystemSegments）。基底按段组成：开头一句身份、<tools>、<rules>、<project_context>、<skills>、<cwd>，
 * 段与段之间空一行，标签与以前相同（界面的「上下文」面板与比对台按段认）。
 *
 * 以前基底由旧 agent 库拼（它的 buildSystemPrompt + 资源加载器 + 设置管理器），那个库删掉之后改成这里自己拼，
 * 措辞是我们自己的。比旧版少了：pi 文档一段（那是另一个应用的说明）、~/.pi/agent 下的 AGENTS.md / SYSTEM.md /
 * APPEND_SYSTEM.md（另一个应用的配置）、工作区级 .pi/settings.json、技能目录里 .gitignore 的排除规则。
 * 多了：搜索点名用 rg / fd、不用 grep -r / find 扫整个目录（三个搜索工具删掉之后它是唯一的防线），
 * 以及 PI_* 四个环境变量的说明。
 *
 * **只读** ~/.pi/agent/settings.json，从不写它，也不写 ~/.pi 下任何东西。
 */
import { PI_ATTRIBUTION, type ClientIdentity, type Message, type ThinkingBudgets, type Tool } from "@earendil-works/pi-ai";
import { getCurrentTools, getToolStateChanges } from "@earendil-works/pi-ai/utils/transcript";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import packageJson from "../../package.json" with { type: "json" };
import type { ToolDefinition } from "./agent-shapes.ts";
import type { BuiltinToolOptions } from "./durable-tools.ts";

/** 一轮重建基础提示要的资源快照（规则文件与技能索引；上下文面板的清单也读它） */
export interface PiResources {
  basePrompt: (selectedTools: readonly string[], definitions: readonly ToolDefinition[]) => string;
  agentsFiles: { path: string; content: string }[];
  skills: { name: string; description: string }[];
  agentDir: string;
  /** 内建工具的装配选项：从 ~/.pi/agent/settings.json 读的三项 */
  builtinOptions: BuiltinToolOptions;
}

/** ~/.pi/agent（环境变量 PI_CODING_AGENT_DIR 可以改）：只读它下面的 settings.json */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["PI_CODING_AGENT_DIR"];
  return override !== undefined && override !== "" ? expandHome(override) : join(homedir(), ".pi", "agent");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** settings.json 里我们用到的几项（其余的属于另一个应用，不读） */
export interface PiSettings {
  autoResizeImages: boolean;
  shellCommandPrefix: string | undefined;
  shellPath: string | undefined;
  enableInstallTelemetry: boolean;
  httpIdleTimeoutMs: number | undefined;
  websocketConnectTimeoutMs: number | undefined;
  retry: { timeoutMs: number | undefined; maxRetries: number | undefined; maxRetryDelayMs: number };
  thinkingBudgets: ThinkingBudgets | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 超时类设置：非负数取整；字符串 "disabled" = 0；数字字符串照数字读；别的当没写 */
export function parseTimeout(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    return trimmed === "" ? undefined : parseTimeout(Number(trimmed));
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** 读 settings.json。文件不在、读坏、某项类型不对：那一项按缺省（自动缩图开、遥测开、重试最长等 60 秒） */
export function readPiSettings(agentDir: string = piAgentDir()): PiSettings {
  let raw: Record<string, unknown> = {};
  try {
    raw = record(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")));
  } catch {
    raw = {};
  }
  const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
  const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const images = record(raw["images"]);
  const provider = record(record(raw["retry"])["provider"]);
  const shellPath = text(raw["shellPath"]);
  const budgets = raw["thinkingBudgets"];
  return {
    autoResizeImages: typeof images["autoResize"] === "boolean" ? images["autoResize"] : true,
    shellCommandPrefix: text(raw["shellCommandPrefix"]),
    shellPath: shellPath === undefined ? undefined : expandHome(shellPath),
    enableInstallTelemetry: typeof raw["enableInstallTelemetry"] === "boolean" ? raw["enableInstallTelemetry"] : true,
    httpIdleTimeoutMs: parseTimeout(raw["httpIdleTimeoutMs"]),
    websocketConnectTimeoutMs: parseTimeout(raw["websocketConnectTimeoutMs"]),
    retry: { timeoutMs: count(provider["timeoutMs"]), maxRetries: count(provider["maxRetries"]), maxRetryDelayMs: count(provider["maxRetryDelayMs"]) ?? 60_000 },
    thinkingBudgets: typeof budgets === "object" && budgets !== null && !Array.isArray(budgets) ? (budgets as ThinkingBudgets) : undefined,
  };
}

// ---------- 项目说明（AGENTS.md 向上找） ----------

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function contextFileIn(dir: string): { path: string; content: string } | null {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      return { path, content: stripBom(readFileSync(path, "utf8")) };
    } catch {
      // 不在 / 读不了：看下一个名字
    }
  }
  return null;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
}

/**
 * 嵌在主仓目录里的 git worktree（`repo/.worktrees/x`）：worktree 自己带一份 AGENTS.md，向上找又会遇到主仓那份，
 * 同一份说明会进两遍。这种情形下跳过主仓的那份；兄弟目录的 worktree（`../repo-x`）向上碰不到主仓，不受影响。
 */
function shadowedMainRepoFile(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitdirLine: string | undefined;
      try {
        if (statSync(dotGit).isDirectory()) return undefined;
        gitdirLine = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      } catch {
        return undefined;
      }
      if (gitdirLine === undefined) return undefined;
      const gitdir = resolve(dir, gitdirLine);
      let common = gitdir;
      try {
        common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
      } catch {
        return undefined;
      }
      const commonReal = realpathOr(common);
      const worktreeRoot = realpathOr(dir);
      const mainRoot = dirname(commonReal);
      if (!isWithin(mainRoot, worktreeRoot) || realpathOr(join(mainRoot, ".git")) !== commonReal) return undefined;
      const own = contextFileIn(worktreeRoot);
      return own === null ? undefined : join(mainRoot, basename(own.path));
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** 从 cwd 一路向上收集项目说明，外层在前；每层只取一个（AGENTS.override.md > AGENTS.md > CLAUDE.md） */
export function loadProjectContextFiles(cwd: string): { path: string; content: string }[] {
  const shadowed = shadowedMainRepoFile(cwd);
  const files: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  let dir = resolve(cwd);
  for (;;) {
    const file = contextFileIn(dir);
    const isShadowed = file !== null && shadowed !== undefined && join(realpathOr(dir), basename(file.path)) === shadowed;
    if (file !== null && !isShadowed && !seen.has(file.path)) {
      files.unshift(file);
      seen.add(file.path);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

// ---------- 技能索引 ----------

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  /** frontmatter 写了 disable-model-invocation: true：只能点名用，不进索引 */
  hidden: boolean;
}

function frontmatterOf(raw: string): Record<string, unknown> | null {
  const text = stripBom(raw).replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  try {
    return record(parseYaml(text.slice(4, end)));
  } catch {
    return null;
  }
}

function skillFromFile(filePath: string): SkillEntry | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const front = frontmatterOf(raw);
  if (front === null) return null;
  const description = front["description"];
  if (typeof description !== "string" || description.trim() === "") return null;
  const name = typeof front["name"] === "string" && front["name"] !== "" ? front["name"] : basename(dirname(filePath));
  return { name, description, filePath, hidden: front["disable-model-invocation"] === true };
}

function entryKind(path: string, entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): "file" | "dir" | null {
  if (entry.isSymbolicLink()) {
    try {
      const stat = statSync(path);
      return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
    } catch {
      return null;
    }
  }
  return entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
}

/**
 * 一个技能目录：有 SKILL.md 的目录就是一个技能、不再往下找；否则往子目录里找（跳过点开头的与 node_modules）。
 * 顶层目录里直接放的 .md，frontmatter 带 description 的也算一个技能。
 */
function skillsInDir(dir: string, top: boolean): SkillEntry[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skillMd = entries.find((entry) => entry.name === "SKILL.md" && entryKind(join(dir, entry.name), entry) === "file");
  if (skillMd !== undefined) {
    const skill = skillFromFile(join(dir, "SKILL.md"));
    return skill === null ? [] : [skill];
  }
  const found: SkillEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    const kind = entryKind(path, entry);
    if (kind === "dir") found.push(...skillsInDir(path, false));
    else if (kind === "file" && top && entry.name.endsWith(".md")) {
      const skill = skillFromFile(path);
      if (skill !== null) found.push(skill);
    }
  }
  return found;
}

/** 按给定目录顺序收集技能：同一个文件（经链接）只算一次，同名的先到先得 */
export function loadSkills(dirs: readonly string[]): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  const files = new Set<string>();
  for (const dir of dirs) {
    let found: SkillEntry[];
    try {
      const stat = statSync(dir);
      found = stat.isDirectory() ? skillsInDir(dir, true) : stat.isFile() && dir.endsWith(".md") ? [skillFromFile(dir)].filter((skill): skill is SkillEntry => skill !== null) : [];
    } catch {
      continue;
    }
    for (const skill of found) {
      const key = realpathOr(skill.filePath);
      if (files.has(key) || byName.has(skill.name)) continue;
      files.add(key);
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** 技能索引段的正文；`reader` 是模型用来读技能文件的工具（read 优先，没有就 bash） */
export function formatSkillsIndex(skills: readonly SkillEntry[], reader: "read" | "bash" | "indirect"): string {
  const visible = skills.filter((skill) => !skill.hidden);
  if (visible.length === 0) return "";
  const how = reader === "read" ? "read it with the read tool" : reader === "bash" ? "read it with bash" : "read it";
  return [
    `Each skill below is an instruction file for one kind of task. When the task in front of you matches a skill's description, ${how} before you start.`,
    "Relative paths inside a skill are relative to the skill's folder (the parent of SKILL.md); use absolute paths in tool calls.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

// ---------- 基底 ----------

const PREAMBLE = "You are a coding assistant running inside Orbita, a desktop agent on the user's own computer. Help the user inspect files, run commands, and change code and documents.";

/** 四个内建工具在 <tools> 里的一行（它们的工具定义来自运行时，不带简介） */
const BUILTIN_SNIPPETS: Readonly<Record<string, string>> = {
  bash: "Run a shell command in the working directory",
  read: "Read a file: text with line limits, or an image sent as an attachment",
  edit: "Change an existing file by replacing exact pieces of text, several pieces in one call",
  write: "Create a file, or replace a file's whole contents",
};

/** 内建工具在场时才出现的规则（按工具出现的先后） */
function builtinRules(selected: ReadonlySet<string>): string[] {
  const rules: string[] = [];
  if (selected.has("read")) rules.push("Look at files with read, not cat, head or sed.");
  if (selected.has("edit")) {
    rules.push(
      "Change an existing file with edit, and give all changes to one file in a single call. Each oldText must be short, match the file exactly, occur only once, and not overlap another.",
    );
  }
  if (selected.has("write")) rules.push("Use write only to create a new file or to rewrite a whole file.");
  if (selected.has("bash")) {
    rules.push(
      "Search with rg (file contents) and fd (file names). Do not run `grep -r` or `find` over a whole directory: they walk into node_modules and other large folders and take seconds.",
      "In bash, PI_SESSION_ID, PI_PROVIDER, PI_MODEL and PI_REASONING_LEVEL hold this conversation's id, service provider, model and thinking level.",
    );
  }
  return rules;
}

function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export interface BasePromptInput {
  cwd: string;
  /** 这一轮激活的工具名，按激活顺序 */
  selectedTools: readonly string[];
  /** 璇玑自己的工具定义（简介与规则从这里取） */
  definitions: readonly ToolDefinition[];
  contextFiles: readonly { path: string; content: string }[];
  skills: readonly SkillEntry[];
}

/** 拼基底。纯函数：同样的输入出同样的字 */
export function buildBasePrompt(input: BasePromptInput): string {
  const selected = new Set(input.selectedTools);
  const snippets = new Map<string, string>();
  const guidelines = new Map<string, string[]>();
  for (const definition of input.definitions) {
    const snippet = oneLine(definition.promptSnippet);
    if (snippet !== "") snippets.set(definition.name, snippet);
    const lines = (definition.promptGuidelines ?? []).map((line) => line.trim()).filter((line) => line !== "");
    if (lines.length > 0) guidelines.set(definition.name, lines);
  }
  const toolLines = input.selectedTools.flatMap((name) => {
    const snippet = BUILTIN_SNIPPETS[name] ?? snippets.get(name);
    return snippet === undefined ? [] : [`- ${name}: ${snippet}`];
  });
  const rules: string[] = [];
  const seen = new Set<string>();
  const addRule = (rule: string): void => {
    if (rule === "" || seen.has(rule)) return;
    seen.add(rule);
    rules.push(rule);
  };
  for (const rule of builtinRules(selected)) addRule(rule);
  for (const name of input.selectedTools) for (const rule of guidelines.get(name) ?? []) addRule(rule);
  addRule("Be concise in your final answers.");
  addRule("Show file paths clearly when working with files.");

  const sections: [string, string][] = [
    ["tools", `${toolLines.length > 0 ? toolLines.join("\n") : "(none)"}\n\nTools without a line here are described in their own definitions.`],
    ["rules", rules.map((rule) => `- ${rule}`).join("\n")],
  ];
  if (input.contextFiles.length > 0) {
    sections.push([
      "project_context",
      [
        "Instructions for this project, from the AGENTS.md files of the working directory and the folders above it (outer folders first):",
        ...input.contextFiles.map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`),
      ].join("\n\n"),
    ]);
  }
  const reader = selected.has("read") ? "read" : selected.has("bash") ? "bash" : undefined;
  if (reader !== undefined) {
    const index = formatSkillsIndex(input.skills, reader);
    if (index !== "") sections.push(["skills", index]);
  }
  sections.push(["cwd", input.cwd.replace(/\\/g, "/")]);
  return [PREAMBLE, ...sections.map(([name, body]) => `<${name}>\n${body}\n</${name}>`)].join("\n\n");
}

/**
 * 每轮现读（用户中途改了 AGENTS.md、链了新技能，下一轮就生效）。
 * `resolveShellPath` 是进程级缓存的 bash 探测（shell-path.ts）。
 */
export async function loadPiResources(input: {
  cwd: string;
  skillsDirs: readonly string[];
  resolveShellPath: () => string | undefined;
}): Promise<PiResources> {
  const agentDir = piAgentDir();
  const settings = readPiSettings(agentDir);
  const contextFiles = loadProjectContextFiles(input.cwd);
  const skills = loadSkills(input.skillsDirs);
  return {
    basePrompt: (selectedTools, definitions) => buildBasePrompt({ cwd: input.cwd, selectedTools, definitions, contextFiles, skills }),
    agentsFiles: contextFiles.map((file) => ({ path: file.path, content: file.content })),
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    agentDir,
    builtinOptions: {
      autoResizeImages: settings.autoResizeImages,
      commandPrefix: settings.shellCommandPrefix,
      // 用户在设置里显式指定了 shell 就用它，没指定才补探测到的
      shellPath: settings.shellPath ?? input.resolveShellPath(),
    },
  };
}

/**
 * 激活顺序（pi 的 _restoreToolsFromTranscript + _applyToolLoadout）：此前清单里的工具保持原位、新出现的接在后面。
 * 它决定 pi 基础提示里工具小节的顺序；发给模型的工具数组顺序见 offeredOrder。
 */
export function loadoutOrder(previous: readonly string[], desired: readonly string[]): string[] {
  const wanted = new Set(desired);
  const kept = previous.filter((name) => wanted.has(name));
  const keptSet = new Set(kept);
  return [...kept, ...desired.filter((name) => !keptSet.has(name))];
}

/**
 * 发给模型的工具数组顺序：**就是旧内核用的那两个 pi-ai 函数**——agent-loop 每次请求前算
 * getToolStateChanges(此前看到的清单, 这一轮激活的清单)，把变化接在历史后面，模型看到的是 getCurrentTools 的回放：
 * 声明没变的保持原位；声明变了的（描述 / 参数改过）先删后加、挪到末尾；新出现的按激活顺序接在末尾。
 * `previous`：模型此前看到的声明（新内核从会话的 pi.system 条目回放；刚迁来、还没发过请求的会话用迁移时从旧本子
 * system 记录回放出来的那份，kernel-wire.ts 的 legacyTools）。`current`：这一轮按激活顺序排好的声明。
 */
export function offeredOrder(previous: readonly Tool[], current: readonly Tool[]): string[] {
  const changes = getToolStateChanges(previous, current);
  const replay: Message[] = [
    { role: "system", content: "", toolsAdded: [...previous], timestamp: 0 },
    { role: "system", content: "", toolsRemoved: changes.toolsRemoved, toolsAdded: changes.toolsAdded, timestamp: 0 },
  ];
  return getCurrentTools(replay).map((tool) => tool.name);
}

/**
 * 请求层的选项：从 ~/.pi/agent/settings.json 拼成 durable 的 HarnessOptions.identity 与 settings.stream
 * （超时、重试、思考预算、遥测署名）。工作区级的 `.pi/settings.json` 不读。
 */
export interface PiRequestOptions {
  identity: ClientIdentity;
  stream: {
    timeoutMs: number;
    websocketConnectTimeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs?: number;
    thinkingBudgets?: ThinkingBudgets;
  };
}

/** 环境变量开关：1 / true / yes 算开 */
function truthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** HTTP 空闲超时的缺省（5 分钟） */
const PI_HTTP_IDLE_TIMEOUT_MS = 300_000;

/** 运行时（pi-durable）的版本号：请求头里的版本。package.json 里是精确锁版本，就是装着的那一版 */
const RUNTIME_VERSION = packageJson.dependencies["@earendil-works/pi-durable"];

export function piRequestOptions(): PiRequestOptions {
  const settings = readPiSettings();
  const telemetry = process.env["PI_TELEMETRY"];
  const attribution = (telemetry !== undefined ? truthyFlag(telemetry) : settings.enableInstallTelemetry) ? PI_ATTRIBUTION : null;
  const provider = settings.retry;
  const idle = settings.httpIdleTimeoutMs;
  const websocket = settings.websocketConnectTimeoutMs;
  const budgets = settings.thinkingBudgets;
  return {
    // 详细 User-Agent 带运行时的版本号（与以前同值），遥测开着才带 pi 的署名
    identity: { userAgent: "detailed", version: RUNTIME_VERSION, attribution },
    stream: {
      timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle ?? PI_HTTP_IDLE_TIMEOUT_MS),
      ...(websocket === undefined ? {} : { websocketConnectTimeoutMs: websocket }),
      ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      ...(provider.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: provider.maxRetryDelayMs }),
      ...(budgets === undefined ? {} : { thinkingBudgets: budgets }),
    },
  };
}
