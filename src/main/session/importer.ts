/**
 * Proma pi 会话同构导入引擎 —— 纯模块：不 import electron，可被 `node --test` 直接测。
 *
 * 通路（调研 2026-09-21 §二）：Proma 的 pi 真源（header version 3）与 orbita 锁定的
 * pi 0.84.3 同版本同格式。导入 = **复制 pi 文件到自己的目录（自包含，不引用
 * ~/.proma-dev）+ 从 entries 离线派生 orbita 的 transcript JSONL + 生成 SessionMeta**。
 * 全程无 LLM 参与，确定性映射。
 *
 * ## 源目录绝对只读
 *
 * `~/.proma-dev` 是用户另一个应用的数据，引擎对它只做 `readFile`。**刻意不用
 * `SessionManager.open()` 读源文件**——它的构造器会 mkdir、`_setSessionFile` 会就地
 * 重写 v1/v2 文件（迁移副作用）；这里全走包导出的纯函数
 * （`parseSessionEntries` / `migrateSessionEntries`），
 * 版本迁移在内存里做完、写到 orbita 自己的副本上，源文件一个字节都不动。
 *
 * ## 幂等与再次导入
 *
 * 幂等键 = 源 pi 文件绝对路径，存在新会话 meta 的 `importedFrom` 里（契约层 commit
 * 讲了为什么不另立 state 文件）。执行前重新扫描，本次扫描内的同源重复按跳过处理。
 * 解析外部 JSONL 一律坏行跳过（pi 的 `parseSessionEntries` 就是这么做的），一条坏行不炸整批。
 *
 * 导过的会话不再一律跳过（2026-09-24 再次导入）：orbita 的 pi 副本就是导入那一刻的源文件，
 * 两份按 entry id 对齐（reimportState），源里多出新消息的列为 updated / diverged；
 * 导过、后来在 orbita 删掉的靠导入清单认出（import-ledger.ts），列为 deleted。
 */
import { copyFile, mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseSessionEntries,
  migrateSessionEntries,
  SessionManager,
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type {
  AssistantTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
} from "@earendil-works/pi-protocol";
import { writeTextAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import { isEmptyErrorAssistantEntry } from "../../agent/branch-cut.ts";
import { parseThinkingLevel } from "../../shared/thinking.ts";
import { deriveWorkspaceName, normalizeWorkspaceName, type Workspace } from "../../shared/workspace.ts";
import {
  claudeRowsToMessages,
  hasAssistantRow,
  lastModelFromRows,
  parseClaudeRows,
  type ClaudeMainRow,
} from "./claude-legacy.ts";
import {
  claudeCodeRootUuid,
  parseClaudeCodeSession,
  parseClaudeDesktopSession,
  type ClaudeDesktopSession,
} from "./claude-code.ts";
import { kimiBlobRefs, parseKimiSessionState, parseKimiWire } from "./kimi-code.ts";
import { onlyWrittenMessage } from "./greeting-only.ts";
import {
  opencodeSessionBytes,
  opencodeToMessages,
  readOpencodeMessages,
  readOpencodeSessions,
  withOpencodeDb,
} from "./opencode.ts";
import { listReasonixSessions, parseReasonixRows, readReasonixMeta, reasonixToMessages } from "./reasonix.ts";
import { aggregatePrefixUsage } from "./store.ts";
import {
  claudeCodeSkillDirs,
  importSkills,
  promaBuiltInSkills,
  promaSkillDirs,
  promaWorkspaceFolders,
  scanSkillDirs,
  type SkillImportTarget,
  type SkillSelection,
  type SkillSourceDir,
} from "../skill/import.ts";
import {
  importMcpServers,
  mergeMcpEntries,
  readClaudeCodeMcp,
  readKimiCodeMcp,
  readOpencodeMcp,
  readPromaMcp,
  type McpSourceEntry,
} from "../mcp/import.ts";
import type { McpServer } from "../../shared/mcp.ts";
import { promaUserTextMap, promaUserTexts, withUserTexts } from "./proma-user-text.ts";
import { appendImportLedger, readImportLedger, type ImportLedgerLine } from "./import-ledger.ts";
import {
  deriveSessionTitle,
  recentQueriesFromRecords,
  type SessionMeta,
  type SessionRecord,
} from "../../shared/session.ts";
import {
  isSelectablePlanItem,
  type ImportChange,
  type ImportDestination,
  type ImportDestinationChoice,
  type ImportGreetingCheckPlan,
  type ImportPlanItem,
  type ImportRunReport,
  type ImportScanReport,
  type ImportSkipItem,
  type ImportSkipReason,
  type ImportSourceId,
  type ImportSourceKind,
  type ImportSourceProbe,
  type ImportWorkspacePlan,
} from "../../shared/import.ts";

/** Claude Code 来源要读的位置。全部**只读**。 */
export interface ClaudeCodePaths {
  /** 会话文件根（~/.claude/projects）：每个项目一个子目录，目录里是 <会话 id>.jsonl */
  projectsDir: string;
  /** Claude 桌面应用的会话清单目录。不存在（只用命令行、非 macOS）照常扫，只是认不出续接关系 */
  desktopSessionsDir: string;
  /** 家目录：在家目录里跑的会话不算有文件夹（不为它建工作区） */
  home: string;
  /** Claude Code 的 skills 目录（~/.claude/skills；桌面应用同步下来的在它的 synced/ 下） */
  skillsDir: string;
  /** Claude Code 的用户配置（~/.claude.json）：只读其中的 mcpServers（全局与各项目） */
  claudeJson: string;
}

/** Kimi Code 来源要读的位置（都在 ~/.kimi-code 下）。全部**只读**。 */
export interface KimiCodePaths {
  /** 会话根：sessions/<工作区 id>/<会话 id>/（state.json + agents/main/wire.jsonl + 图片 blobs） */
  sessionsDir: string;
  /** 工作区表：会话自己没记 cwd（旧版 state.json）时取工作区的 root，另认出源里删掉的工作区 */
  workspacesFile: string;
  /** MCP 配置（{ mcpServers }，Claude Desktop 同形） */
  mcpFile: string;
  /** 家目录：在家目录里跑的会话不算有文件夹 */
  home: string;
}

/** opencode 来源要读的位置。全部**只读**（库按只读方式打开）。 */
export interface OpencodePaths {
  /** 会话库（~/.local/share/opencode/opencode.db） */
  dbFile: string;
  /** 用户配置（~/.config/opencode/opencode.json）：只读其中的 mcp */
  configFile: string;
  /** 家目录：在家目录里开的会话不算有文件夹 */
  home: string;
}

/** Reasonix 桌面版来源要读的位置。全部**只读**。 */
export interface ReasonixPaths {
  /** 会话根（Windows %APPDATA%/reasonix/projects）：每个项目一个子目录，sessions/ 下是 <id>.jsonl */
  projectsRoot: string;
  /** 家目录：在家目录里开的会话不算有文件夹 */
  home: string;
}

/** 引擎对外的全部环境依赖。生产由 main 装配，测试注入临时目录与可预测的 id。 */
export interface ImporterDeps {
  /** Proma 数据根（~/.proma-dev）。**只读** */
  promaRoot: string;
  /** Claude Code 来源的位置。不传 = 扫描勾了它也不读 */
  claudeCode?: ClaudeCodePaths;
  /** Kimi Code 来源的位置。不传 = 扫描勾了它也不读 */
  kimiCode?: KimiCodePaths;
  /** opencode 来源的位置。不传 = 扫描勾了它也不读 */
  opencode?: OpencodePaths;
  /** Reasonix 桌面版来源的位置。不传 = 扫描勾了它也不读 */
  reasonix?: ReasonixPaths;
  /** 多家共用的 skills 目录（~/.agents/skills，来源 agent-skills）。不传 = 勾了也不读 */
  agentSkillsDir?: string;
  /** orbita 已有的 skill slug（含只剩断链的）：skills 重名判断的底 */
  existingSkills?: readonly string[];
  /** orbita mcp.json 里已有的 server 名：MCP 重名判断的底 */
  existingMcp?: readonly string[];
  /** 「只随手发了一句」检查会用的模型（页面据此写提醒）；不传 = 没有可用模型 */
  greetingModel?: ImportGreetingCheckPlan["model"];
  /** 额外合法源根（Proma 迁移史的旧根 ~/.proma：索引里仍有条目指向它，文件仍在）。
   *  防御边界是「这几个根之内」，不传则只认 promaRoot */
  extraSourceRoots?: readonly string[];
  /** orbita 的 pi 本子目录（pi-sessions/）：源 pi 文件的副本落这里 */
  piSessionDir: string;
  /** cwd 三级链的最后一环：无归属且源 cwd 不可用时用（= WorkspaceStore.defaultPath） */
  defaultCwd: string;
  /** orbita 现有工作区（扫描做同址合并的匹配底） */
  workspaces: Workspace[];
  /** orbita 现有会话 meta（幂等判重底） */
  existingMetas: SessionMeta[];
  /** 导入清单 imports.jsonl 的路径（import-ledger.ts）：扫描读它认出「在 orbita 删过」的，执行往里追加 */
  ledgerFile: string;
  /** 已注册模型全集（模型映射的候选） */
  registeredModels: readonly { providerId: string; modelId: string }[];
  /** 模型映射 miss 的兜底（orbita 当前默认 provider/model） */
  fallbackModel: { providerId: string; modelId: string };
  /** 铸新 id（会话与工作区）。注入为了测试可预测 */
  newId(): string;
}

/** 执行阶段额外依赖：落盘动作的注入（生产接 SessionStore / WorkspaceStore，测试接假实现）。 */
export interface RunImporterDeps extends ImporterDeps {
  /** 新建工作区落盘（扫描期已铸好 id 与名字，执行按它落） */
  createWorkspace(workspace: { id: string; name: string; path: string }): Promise<void>;
  /** 单条会话落盘（meta + transcript 原子写；路径规则在 SessionStore） */
  persistSession(meta: SessionMeta, records: readonly SessionRecord[]): Promise<void>;
  /** skill 落进中心存储（生产接 SkillStore） */
  skillTarget: SkillImportTarget;
  /** MCP server 加进 orbita 的 mcp.json（生产接 McpStore.add + 运行时 reload） */
  mcpTarget: { add(name: string, server: McpServer): Promise<void>; reload(): Promise<void> };
  /** 既有会话追加新消息后的落盘：整份 transcript + meta 的派生字段（SessionStore.commitImportUpdate） */
  refreshSession(
    id: string,
    records: readonly SessionRecord[],
    patch: Pick<SessionMeta, "recentQueries" | "stats" | "updatedAt">,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// 探测（只 stat）
// ---------------------------------------------------------------------------

/**
 * Proma 来源的探测：列出扫描会读的全部路径，只 stat 索引文件判断在不在。**不读内容**——
 * 页面一打开就跑它，用户还没勾任何东西。paths 与扫描的实际读取范围一一对应：
 * 会话索引、工作区表、pi 真源目录、claude legacy 渲染目录，以及旧根的 pi 真源（索引里
 * 有条目仍指向那里）。
 */
export async function probeProma(promaRoot: string, extraRoots: readonly string[] = []): Promise<ImportSourceProbe> {
  const index = join(promaRoot, "agent-sessions.json");
  let found = false;
  try {
    found = (await stat(index)).isFile();
  } catch {
    found = false;
  }
  return {
    id: "proma",
    label: "Proma",
    kind: "app",
    paths: [
      index,
      join(promaRoot, "agent-workspaces.json"),
      join(promaRoot, "sdk-config", "sessions"),
      join(promaRoot, "agent-sessions"),
      ...extraRoots.map((root) => join(root, "sdk-config", "sessions")),
      join(promaRoot, "agent-workspaces", "*", "skills"),
      join(promaRoot, "default-skills"),
      join(promaRoot, "agent-workspaces", "*", "mcp.json"),
    ],
    found,
  };
}

/**
 * Claude Code 来源的探测：只 stat 会话根目录。paths 是扫描会读的全部位置——会话文件，
 * 以及 Claude 桌面应用的会话清单（只用来认出被续接取代的旧文件、取它显示的标题）。
 */
export async function probeClaudeCode(paths: ClaudeCodePaths): Promise<ImportSourceProbe> {
  let found = false;
  try {
    found = (await stat(paths.projectsDir)).isDirectory();
  } catch {
    found = false;
  }
  return {
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    paths: [paths.projectsDir, paths.desktopSessionsDir, paths.skillsDir, paths.claudeJson],
    found,
  };
}

/** Kimi Code 来源的探测：只 stat 会话根目录。paths 是扫描会读的全部位置。 */
export async function probeKimiCode(paths: KimiCodePaths): Promise<ImportSourceProbe> {
  let found = false;
  try {
    found = (await stat(paths.sessionsDir)).isDirectory();
  } catch {
    found = false;
  }
  return {
    id: "kimi-code",
    label: "Kimi Code",
    kind: "cli",
    paths: [paths.sessionsDir, paths.workspacesFile, paths.mcpFile],
    found,
  };
}

/** opencode 来源的探测：只 stat 会话库。paths 是扫描会读的全部位置。 */
export async function probeOpencode(paths: OpencodePaths): Promise<ImportSourceProbe> {
  let found = false;
  try {
    found = (await stat(paths.dbFile)).isFile();
  } catch {
    found = false;
  }
  return { id: "opencode", label: "opencode", kind: "cli", paths: [paths.dbFile, paths.configFile], found };
}

/** Reasonix 桌面版来源的探测：只 stat 会话根。paths 是扫描会读的全部位置。 */
export async function probeReasonix(paths: ReasonixPaths): Promise<ImportSourceProbe> {
  let found = false;
  try {
    found = (await stat(paths.projectsRoot)).isDirectory();
  } catch {
    found = false;
  }
  return { id: "reasonix", label: "Reasonix", kind: "app", paths: [paths.projectsRoot], found };
}

/** 多家共用的 skills 目录（~/.agents/skills）：只 stat 这一个目录。 */
export async function probeAgentSkills(dir: string): Promise<ImportSourceProbe> {
  let found = false;
  try {
    found = (await stat(dir)).isDirectory();
  } catch {
    found = false;
  }
  return { id: "agent-skills", label: "Shared agent skills", kind: "folder", paths: [dir], found };
}

// ---------------------------------------------------------------------------
// Proma 索引解析
// ---------------------------------------------------------------------------

/** Proma 索引（agent-sessions.json）里我们用得上的字段。字段历经五代演进，只认这些。 */
interface PromaSessionIndexEntry {
  id: string;
  title: string;
  piSessionFile: string;
  workspaceId: string | null;
  modelId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean;
  pinned: boolean;
  starred: boolean;
  /** Proma 的 `parentSessionId`：delegation 派出的子会话指向母会话的 Proma id；null = 根会话 */
  parentSourceId: string | null;
}

/** claude legacy 索引条目（无 piSessionFile，源文件按 <promaRoot>/agent-sessions/<id>.jsonl 推导）。 */
interface PromaClaudeIndexEntry {
  id: string;
  title: string;
  workspaceId: string | null;
  modelId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean;
  pinned: boolean;
  starred: boolean;
  parentSourceId: string | null;
}

/** Proma 工作区（agent-workspaces.json）里我们用得上的字段。 */
interface PromaWorkspaceEntry {
  id: string;
  name: string;
  /** 缺席 = Proma 的默认收容区（杂项），不映射成 orbita 工作区 */
  projectRootPath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 解 agent-sessions.json。**逐条容错**：一条坏了标 bad-index-entry 进跳过清单，
 * 不挡其余 900 多条（与 readLog 的坏行纪律同源）。没有 piSessionFile 的条目分两路：
 * legacyTranscript.sourceRuntime === "claude" 的进 claude 条目（渲染 JSONL 转换导入），
 * 其余（旧扁平 / draft）只计数不进清单——PR-3 或明确放弃的范围。
 */
export function parsePromaSessions(raw: string): {
  entries: PromaSessionIndexEntry[];
  claudeEntries: PromaClaudeIndexEntry[];
  bad: ImportSkipItem[];
  withoutPiFile: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("agent-sessions.json is not valid JSON");
  }
  const list = isRecord(parsed) && Array.isArray(parsed["sessions"]) ? parsed["sessions"] : [];
  const entries: PromaSessionIndexEntry[] = [];
  const claudeEntries: PromaClaudeIndexEntry[] = [];
  const bad: ImportSkipItem[] = [];
  let withoutPiFile = 0;
  list.forEach((item, index) => {
    if (!isRecord(item)) {
      bad.push({ sourceId: `#${index}`, title: null, reason: "bad-index-entry", detail: "not an object" });
      return;
    }
    const id = optionalString(item["id"]);
    if (id === null) {
      bad.push({
        sourceId: `#${index}`,
        title: optionalString(item["title"]),
        reason: "bad-index-entry",
        detail: "missing id",
      });
      return;
    }
    const common = {
      id,
      title: optionalString(item["title"]) ?? "",
      workspaceId: optionalString(item["workspaceId"]),
      modelId: optionalString(item["modelId"]),
      createdAt: optionalNumber(item["createdAt"]),
      updatedAt: optionalNumber(item["updatedAt"]),
      archived: item["archived"] === true,
      // 两个独立字段：pinned = 置顶；starred = 星标（Proma 07-21 加，「不影响排序或置顶」）。
      // 早先把 starred 也当置顶导，是把它误读成了 pinned 的新名字（本机 pinned=true 0 条、
      // starred=true 55 条，导进来一片置顶）
      pinned: item["pinned"] === true,
      starred: item["starred"] === true,
      // 只认 delegation 的 parentSessionId。explorationParentSessionId（Proma 的探索分叉）
      // 是从某条消息岔出去的独立会话，不是子会话，照根会话导
      parentSourceId: optionalString(item["parentSessionId"]),
    };
    const piSessionFile = optionalString(item["piSessionFile"]);
    if (piSessionFile === null) {
      const legacy = isRecord(item["legacyTranscript"])
        ? optionalString(item["legacyTranscript"]["sourceRuntime"])
        : null;
      if (legacy === "claude") claudeEntries.push(common);
      else withoutPiFile += 1;
      return;
    }
    entries.push({ ...common, piSessionFile });
  });
  return { entries, claudeEntries, bad, withoutPiFile };
}

/** 解 agent-workspaces.json。坏条目跳过（它只是映射辅助，不值得拦整批）。 */
export function parsePromaWorkspaces(raw: string): PromaWorkspaceEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("agent-workspaces.json is not valid JSON");
  }
  const list = isRecord(parsed) && Array.isArray(parsed["workspaces"]) ? parsed["workspaces"] : [];
  const out: PromaWorkspaceEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = optionalString(item["id"]);
    const name = optionalString(item["name"]);
    if (id === null || name === null) continue;
    out.push({ id, name, projectRootPath: optionalString(item["projectRootPath"]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pi entries → orbita SessionRecord[]
// ---------------------------------------------------------------------------

type UserContent = Extract<TranscriptItem, { role: "user" }>["content"][number];
type AssistantContent = AssistantTranscriptItem["content"][number];
type ToolContent = ToolTranscriptItem["content"][number];

/** entry.message 的最小结构（pi 文件里它就是 pi-ai 的 Message，但按未知输入防御）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function messageTimestamp(entry: SessionMessageEntry, message: Record<string, unknown>): number {
  const ts = optionalNumber(message["timestamp"]);
  if (ts !== null) return ts;
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 未知形状（未来 pi 版本的新内容类型）原样丢弃，不猜——坏一条好过错一条。 */
function toUserBlocks(content: unknown): UserContent[] {
  const blocks: UserContent[] = [];
  if (typeof content === "string") {
    if (content !== "") blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      blocks.push({ type: "text", text: record["text"] });
    } else if (
      record["type"] === "image" &&
      typeof record["data"] === "string" &&
      typeof record["mimeType"] === "string"
    ) {
      blocks.push({ type: "image", data: record["data"], mimeType: record["mimeType"] });
    }
  }
  return blocks;
}

function toAssistantBlocks(content: unknown): AssistantContent[] {
  const blocks: AssistantContent[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      blocks.push({ type: "text", text: record["text"] });
    } else if (record["type"] === "thinking" && typeof record["thinking"] === "string") {
      const redacted = record["redacted"];
      blocks.push(
        typeof redacted === "boolean"
          ? { type: "thinking", thinking: record["thinking"], redacted }
          : { type: "thinking", thinking: record["thinking"] },
      );
    } else if (
      record["type"] === "toolCall" &&
      typeof record["id"] === "string" &&
      typeof record["name"] === "string"
    ) {
      blocks.push({
        type: "toolCall",
        toolCallId: record["id"],
        toolName: record["name"],
        // 入参本来就是模型产出的 JSON（pi-ai 上游声明 Record<string, any>），
        // 与 transcript-adapter 的 toAssistantContent 同一个形合点
        input: record["arguments"] as Extract<AssistantContent, { type: "toolCall" }>["input"],
      });
    }
  }
  return blocks;
}

function toToolBlocks(content: unknown): ToolContent[] {
  const blocks: ToolContent[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      blocks.push({ type: "text", text: record["text"] });
    } else if (
      record["type"] === "image" &&
      typeof record["data"] === "string" &&
      typeof record["mimeType"] === "string"
    ) {
      blocks.push({ type: "image", data: record["data"], mimeType: record["mimeType"] });
    }
  }
  return blocks;
}

/**
 * assistant 条目的完整构造（含终态判定），与 transcript-adapter 的 finalAssistantItem
 * 同一套规则：error/aborted 各自成态；协议只认 length/toolUse 两个 stopReason，
 * 其余落 "stop"。各写一份是因为输入形状不同（离线 entry vs 实时事件），
 * 规则保持一致由快照测试锚定。返回具体分支的字面量类型，不做 spread 拼接。
 */
function assistantRecord(
  entry: SessionMessageEntry,
  message: Record<string, unknown>,
  timestamp: number,
): AssistantTranscriptItem {
  const base = {
    id: entry.id,
    role: "assistant" as const,
    content: toAssistantBlocks(message["content"]),
    model: {
      provider: optionalString(message["provider"]) ?? "unknown",
      id: optionalString(message["model"]) ?? "unknown",
    },
    ...(asRecord(message["usage"]) === null ? null : { usage: message["usage"] as Usage }),
    timestamp,
  };
  const stopReason = message["stopReason"];
  if (stopReason === "error") return { ...base, status: "error" as const, stopReason: "error" as const };
  if (stopReason === "aborted") return { ...base, status: "aborted" as const, stopReason: "aborted" as const };
  // pi 的 StopReason 比协议宽（还有 pending / deferred）；只有 length / toolUse
  // 协议认，其余落回 "stop"——它表示「就这么结束了」，是最不失真的兜底
  if (stopReason === "length" || stopReason === "toolUse") {
    return { ...base, status: "complete" as const, stopReason };
  }
  return { ...base, status: "complete" as const, stopReason: "stop" as const };
}

/** 从 assistant 消息的 content 里收 toolCallId → 入参（文件顺序保证先于对应 toolResult）。 */
function collectToolInputs(content: unknown, into: Map<string, unknown>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const record = asRecord(block);
    if (record === null || record["type"] !== "toolCall") continue;
    const id = optionalString(record["id"]);
    if (id !== null) into.set(id, record["arguments"]);
  }
}

/**
 * 会话当前分支上的全部 entry，按时间顺序：从文件最后一条沿 parentId 走到根再反转——与 pi
 * 自己的 buildSessionPath 同一条规则（它没导出）。Proma 回退重答留下的旧枝不在路径上，
 * 与 Proma 界面显示的一致。
 *
 * **不用 buildContextEntries**：那是发给模型的上下文，压缩过的会话只留压缩点之后的条目。
 * transcript 是给人看的全量历史——orbita 原生会话压缩时 recorder 只是在原位追加一条界碑，
 * 之前的记录都还在。早先导入用了前者，本机 17 条压缩过的会话丢了约 141 条用户消息
 * （例：一条会话 pi 里 14 条用户消息，transcript 只剩 2 条）。
 *
 * 成环（只可能来自手改的文件）走到重复节点即停，不无限展开。
 */
export function branchEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = entries[entries.length - 1];
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path.reverse();
}

/**
 * 当前分支的 entry 列表（branchEntries）→ orbita 的 SessionRecord[]。
 *
 * - message：user / assistant / toolResult 翻译成 TranscriptItem；**空 error 回答不进**
 *   （isEmptyErrorAssistantEntry——与落盘侧、分支对账侧同一个谓词，三处共享）。
 * - compaction → CompactedRecord 界碑，落在它在历史里的原位（tokensAfter pi 不给，缺省——展示时回退）。
 * - model_change / thinking_level_change / custom / label / session_info / branch_summary
 *   不进 transcript：transcript 是渲染投影，不是发给模型的上下文（那是 pi 副本的事，
 *   续聊时 runtime 从副本重建）。branch_summary 在本机 Proma 数据里不存在。
 *
 * toolResult 的 input 必填但 pi 的 toolResult 不带——从**全局前文**的 toolCall 块里
 * 按 toolCallId 找（同一个 id 在分支上出现两次时后者覆盖前者，文件顺序即时间顺序）；
 * 找不到（孤儿结果）落 {}，与「凭空编一个入参」相比空对象更诚实。
 */
export function entriesToRecords(entries: readonly SessionEntry[]): SessionRecord[] {
  const records: SessionRecord[] = [];
  const toolInputs = new Map<string, unknown>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      records.push({
        role: "compacted",
        id: entry.id,
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: Date.parse(entry.timestamp) || 0,
      });
      continue;
    }
    if (entry.type !== "message") continue;
    if (isEmptyErrorAssistantEntry(entry)) continue;
    const message = asRecord(entry.message);
    if (message === null) continue;
    const role = message["role"];
    const timestamp = messageTimestamp(entry, message);

    if (role === "user") {
      records.push({
        id: entry.id,
        role: "user",
        content: toUserBlocks(message["content"]),
        timestamp,
      });
      continue;
    }
    if (role === "assistant") {
      collectToolInputs(message["content"], toolInputs);
      records.push(assistantRecord(entry, message, timestamp));
      continue;
    }
    if (role === "toolResult") {
      const toolCallId = optionalString(message["toolCallId"]) ?? "";
      records.push({
        id: entry.id,
        role: "tool",
        toolCallId,
        toolName: optionalString(message["toolName"]) ?? "unknown",
        input: (toolInputs.get(toolCallId) ?? {}) as ToolTranscriptItem["input"],
        content: toToolBlocks(message["content"]),
        timestamp,
        ...(message["isError"] === true
          ? { status: "error" as const, isError: true }
          : { status: "complete" as const, isError: false }),
      });
      continue;
    }
    // 未来 pi 版本的新 role：跳过（同未知块策略——坏一条好过错一条）
  }
  return records;
}

// ---------------------------------------------------------------------------
// 工作区三规则 / 模型映射
// ---------------------------------------------------------------------------

/** 匹配用路径规范化：realpath 解 symlink（路径不在盘上时退 resolve 的字面形）。 */
async function normalizeForMatch(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

interface WorkspaceResolution {
  workspaceId: string | null;
  cwd: string;
  /** 源侧文件夹（Proma 工作区的 projectRootPath）；规则 ② 的三个分支都是 null。页面的分组键 */
  folder: string | null;
  /** 要新建的工作区计划（id 即 workspaceId）；挂既有 / 无归属时为 null */
  create: ImportWorkspacePlan | null;
  /** 命中了哪个既有工作区（同址合并），未命中为 null */
  mergedInto: string | null;
}

/**
 * 工作区三规则（调研 §五，全部确定性）：
 * ① 同址合并：Proma workspace 的 projectRootPath 与 orbita workspace 的 path
 *    规范化后相等 → 挂既有工作区。
 * ② 无归属 / 指向已删工作区 / 属 Proma 默认收容区（无 projectRootPath）→
 *    workspaceId: null（TASKS）。
 * ③ cwd：有归属取适配后工作区 path；无归属取 pi header 原 cwd——**除非它落在
 *    Proma 数据根内部**（会话工作台路径）：那是另一个应用的私有树、也是本次导入
 *    的只读边界，把续聊工具指过去比 homedir 更糟，退 defaultCwd。header cwd
 *    空同样退 defaultCwd。
 */
async function resolveWorkspaceTarget(
  promaWorkspaceId: string | null,
  promaWorkspaces: readonly PromaWorkspaceEntry[],
  orbitaWorkspaces: readonly Workspace[],
  headerCwd: string,
  deps: ImporterDeps,
): Promise<WorkspaceResolution> {
  const promaWorkspace =
    promaWorkspaceId === null ? undefined : promaWorkspaces.find((w) => w.id === promaWorkspaceId);

  // 规则 ② 的三分支：无归属 / 已删 / 收容区
  if (promaWorkspace === undefined || promaWorkspace.projectRootPath === null) {
    return {
      workspaceId: null,
      cwd: usableCwd(headerCwd, deps.promaRoot, deps.defaultCwd),
      folder: null,
      create: null,
      mergedInto: null,
    };
  }

  // 规则 ①：同址合并（realpath 相等）
  const wanted = await normalizeForMatch(promaWorkspace.projectRootPath);
  for (const orbita of orbitaWorkspaces) {
    if ((await normalizeForMatch(orbita.path)) === wanted) {
      return {
        workspaceId: orbita.id,
        cwd: orbita.path,
        folder: promaWorkspace.projectRootPath,
        create: null,
        mergedInto: orbita.id,
      };
    }
  }

  // 同名不同址（或全新路径）：新建。名字沿用 Proma 的，走 orbita 的落盘规则
  // （空白退路径末段、40 字符上限）；id 只铸一次，create.id 就是挂上去的 workspaceId
  const id = deps.newId();
  return {
    workspaceId: id,
    cwd: promaWorkspace.projectRootPath,
    folder: promaWorkspace.projectRootPath,
    create: {
      id,
      name: normalizeWorkspaceName(promaWorkspace.name, promaWorkspace.projectRootPath),
      path: promaWorkspace.projectRootPath,
      merged: false,
    },
    mergedInto: null,
  };
}

/**
 * 用户按文件夹改的去向（Migration 页每组的去向菜单）盖到默认解析上。没改的组原样返回。
 *
 * - tasks：不挂工作区；cwd 取文件夹本身（会话当初就在那儿跑），没有文件夹的组本来就是 Tasks
 * - workspace(id)：挂到这个既有工作区，cwd 取它的 path。**id 不存在就抛错**——页面打开到
 *   点 Import 之间工作区可能被删了，静默退回默认去向等于替用户换了目的地
 * - new-workspace：只在默认解析本来就要新建时成立（文件夹为 null 或已是某个工作区时，
 *   页面不给这个选项）；否则同样抛错，不猜
 */
function applyDestination(
  resolution: WorkspaceResolution,
  overrides: ReadonlyMap<string | null, ImportDestination>,
  deps: ImporterDeps,
): WorkspaceResolution {
  const destination = overrides.get(resolution.folder);
  if (destination === undefined) return resolution;
  if (destination.kind === "tasks") {
    return {
      workspaceId: null,
      cwd: resolution.folder ?? resolution.cwd,
      folder: resolution.folder,
      create: null,
      mergedInto: null,
    };
  }
  if (destination.kind === "workspace") {
    const target = deps.workspaces.find((workspace) => workspace.id === destination.workspaceId);
    if (target === undefined) {
      throw new Error(`The workspace chosen for ${resolution.folder ?? "sessions without a folder"} no longer exists`);
    }
    return {
      workspaceId: target.id,
      cwd: target.path,
      folder: resolution.folder,
      create: null,
      mergedInto: target.id,
    };
  }
  if (resolution.create === null) {
    throw new Error(`${resolution.folder ?? "Sessions without a folder"} can't become a new workspace`);
  }
  return resolution;
}

/** header cwd 可用性：空串或落在 Proma 数据根内 → 不可用，退 defaultCwd。 */
function usableCwd(headerCwd: string, promaRoot: string, defaultCwd: string): string {
  if (headerCwd === "") return defaultCwd;
  const resolved = resolve(headerCwd);
  const root = resolve(promaRoot);
  if (resolved === root || resolved.startsWith(`${root}/`)) return defaultCwd;
  return headerCwd;
}

/** 归一化 model id 供匹配：小写 + 只留字母数字（glm-5.3 ↔ GLM_5.3 这类书写差）。 */
function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 模型映射：按 model id 在已注册模型里匹配。**先精确后归一化**——精确命中不动，
 * 书写差（大小写/分隔符）才走归一化。多个 provider 有同名模型取列表第一个
 * （providers.json 的顺序就是用户排的顺序）。渠道名一票否决：anthropic 渠道跑过
 * glm，渠道在 orbita 无对应物，不看。
 */
export function mapModel(
  promaModelId: string | null,
  registered: readonly { providerId: string; modelId: string }[],
  fallback: { providerId: string; modelId: string },
): { providerId: string; modelId: string; matched: boolean } {
  if (promaModelId !== null) {
    const exact = registered.find((m) => m.modelId === promaModelId);
    if (exact !== undefined) return { providerId: exact.providerId, modelId: exact.modelId, matched: true };
    const normalized = normalizeModelId(promaModelId);
    if (normalized !== "") {
      const loose = registered.find((m) => normalizeModelId(m.modelId) === normalized);
      if (loose !== undefined) return { providerId: loose.providerId, modelId: loose.modelId, matched: true };
    }
  }
  return { providerId: fallback.providerId, modelId: fallback.modelId, matched: false };
}

// ---------------------------------------------------------------------------
// pi 源文件读取（只读！不构造 SessionManager）
// ---------------------------------------------------------------------------

interface PiSource {
  entries: FileEntry[];
  headerCwd: string;
  headerTimestamp: number;
  /** v1/v2 在内存里迁完了，副本要写迁移后的内容而不是原字节 */
  needsRewrite: boolean;
}

/**
 * 读一份源 pi 文件并做合法性检查。**纯读**：parseSessionEntries 坏行跳过，
 * migrateSessionEntries 在内存里迁移。
 * 抛错 = 这条进 bad-session-file（路径越界 / header 缺失 / version 超前 / 读不了）。
 */
async function readPiSource(path: string, promaRoot: string, extraRoots: readonly string[]): Promise<PiSource> {
  // 防御：索引里的路径必须落在已知数据根内（真源在 <root>/sdk-config/sessions/ 下；
  // 真实数据里 66 条仍指旧根 ~/.proma——Proma 从 .proma 迁到 .proma-dev 时索引没重写，
  // 文件仍在），一份被手改过的索引不该让导入器去读任意文件
  const resolved = resolve(path);
  const roots = [resolve(promaRoot), ...extraRoots.map((root) => resolve(root))];
  const inAnyRoot = roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
  if (!inAnyRoot) {
    throw new Error(`session file outside the Proma data roots: ${path}`);
  }
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) throw new Error("source file not found");
    throw cause;
  }
  const entries = parseSessionEntries(raw);
  const header = entries.find((entry) => entry.type === "session");
  if (header === undefined || header.type !== "session") throw new Error("no session header");
  if (typeof header.version === "number" && header.version > CURRENT_SESSION_VERSION) {
    // 我们锁 pi 0.84.3：未来版本的文件硬解可能错，宁可拒绝
    throw new Error(
      `session version ${header.version} is newer than supported (${CURRENT_SESSION_VERSION})`,
    );
  }
  // 先记后迁：migrateSessionEntries 会 mutate 同一个 header 对象（version 被改成 3），
  // 迁移之后再判 needsRewrite 永远是 false，副本会拿着 v2 原字节去续聊
  const legacy =
    header.version === undefined ||
    (typeof header.version === "number" && header.version < CURRENT_SESSION_VERSION);
  if (legacy) migrateSessionEntries(entries);
  const headerTimestamp = Date.parse(header.timestamp);
  return {
    entries,
    headerCwd: header.cwd ?? "",
    headerTimestamp: Number.isNaN(headerTimestamp) ? 0 : headerTimestamp,
    needsRewrite: legacy,
  };
}

// ---------------------------------------------------------------------------
// 扫描（dry-run）
// ---------------------------------------------------------------------------

/**
 * 扫描（dry-run）。`destinations` 是用户按文件夹改过的去向：页面扫描时不传（报告给的是
 * 默认去向），执行时 runImport 带着用户的选择重扫，同一条解析路径算出实际落点。
 * `sources` 是勾选的来源：没勾的一个字节都不读。缺省只扫 Proma（它是第一个来源，旧调用方与测试的默认）。
 */
export async function scanImport(
  deps: ImporterDeps,
  destinations: readonly ImportDestinationChoice[] = [],
  sources: readonly ImportSourceId[] = ["proma"],
): Promise<ImportScanReport> {
  return (await scanWithConfigs(deps, destinations, sources)).report;
}

/**
 * 「只随手发了一句」检查的候选（import:check-greetings）：与扫描同一条路按同样的来源重扫，
 * sourceFile → 用户唯一写过的那条。不收渲染层传来的文字（同执行不收计划的理由）。
 */
export async function scanGreetingCandidates(
  deps: ImporterDeps,
  sources: readonly ImportSourceId[],
): Promise<Map<string, string>> {
  return (await scanWithConfigs(deps, [], sources)).greetingCandidates;
}

/**
 * 扫描的全部产出：报告，加上要导的 MCP 配置本体（报告里只有名字与出处——配置带密钥，不出主进程）。
 */
async function scanWithConfigs(
  deps: ImporterDeps,
  destinations: readonly ImportDestinationChoice[],
  sources: readonly ImportSourceId[],
): Promise<{ report: ImportScanReport; mcpServers: Map<string, McpServer>; greetingCandidates: Map<string, string> }> {
  const overrides = new Map<string | null, ImportDestination>(
    destinations.map((choice) => [choice.folder, choice.destination]),
  );
  const skipped: ImportSkipItem[] = [];
  /** 新会话里用户只写过一条的：sourceFile → 那一条（「只随手发了一句」检查的候选，计划成形后再筛） */
  const singleMessages = new Map<string, string>();
  const skip = (sourceId: string, title: string | null, reason: ImportSkipReason, detail?: string): void => {
    skipped.push(detail === undefined ? { sourceId, title, reason } : { sourceId, title, reason, detail });
  };

  const plan: ImportPlanItem[] = [];
  const newWorkspaceByKey = new Map<string, ImportWorkspacePlan>();
  const mergedIds = new Set<string>();
  let modelFallbackCount = 0;
  let totalBytes = 0;

  // 幂等底：已导入过的源路径 → 对应的 orbita 会话（另导过一份的有两条），+ 本次扫描内的同源去重
  const importedBySource = new Map<string, SessionMeta[]>();
  for (const meta of deps.existingMetas) {
    if (meta.importedFrom === undefined) continue;
    importedBySource.set(meta.importedFrom, [...(importedBySource.get(meta.importedFrom) ?? []), meta]);
  }
  const seenSources = new Set<string>();
  // 导入清单：清单里有、meta 里没有 = 导过、后来在 orbita 删了
  const ledger = await readImportLedger(deps.ledgerFile);
  const everImported = new Set(ledger.map((line) => line.sourceFile));
  const freshChange = (sourceFile: string): ImportChange => (everImported.has(sourceFile) ? "deleted" : "new");

  // 没勾 Proma：索引与工作区表都不读，下面两个 Proma 循环跑空
  let promaSessions: ReturnType<typeof parsePromaSessions> = { entries: [], claudeEntries: [], bad: [], withoutPiFile: 0 };
  if (sources.includes("proma")) {
    try {
      promaSessions = parsePromaSessions(await readFile(join(deps.promaRoot, "agent-sessions.json"), "utf8"));
    } catch (cause) {
      throw new Error(
        `读不了 Proma 会话索引（${join(deps.promaRoot, "agent-sessions.json")}）：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  skipped.push(...promaSessions.bad);

  // 子会话回填的两张表（全部索引条目，不只是进了计划的）：父链，与找「此前已导入」的母会话用的源文件
  const parentSourceById = new Map<string, string>();
  const sourceFileById = new Map<string, string>();
  for (const entry of promaSessions.entries) {
    sourceFileById.set(entry.id, entry.piSessionFile);
    if (entry.parentSourceId !== null) parentSourceById.set(entry.id, entry.parentSourceId);
  }
  for (const entry of promaSessions.claudeEntries) {
    sourceFileById.set(entry.id, claudeSourceFile(deps.promaRoot, entry.id));
    if (entry.parentSourceId !== null) parentSourceById.set(entry.id, entry.parentSourceId);
  }

  let promaWorkspaces: PromaWorkspaceEntry[] = [];
  if (sources.includes("proma")) {
    try {
      promaWorkspaces = parsePromaWorkspaces(await readFile(join(deps.promaRoot, "agent-workspaces.json"), "utf8"));
    } catch {
      // 工作区表读不到 ≠ 导不了：全部按无归属走规则 ②（TASKS）。旧版 Proma 可能
      // 没有这份文件，会话照导，只是没有工作区归属
    }
  }

  for (const entry of promaSessions.entries) {
    if (seenSources.has(entry.piSessionFile)) {
      skip(
        entry.id,
        entry.title || null,
        "already-imported",
        "another index entry with the same source file is already in the plan",
      );
      continue;
    }
    seenSources.add(entry.piSessionFile);
    const copies = importedBySource.get(entry.piSessionFile) ?? [];
    let bytes: number | null;
    try {
      bytes = (await stat(entry.piSessionFile)).size;
    } catch {
      bytes = null;
    }
    // 导过的先走快路：源文件没了（orbita 里的照留）、或与某份副本等长（pi 文件只追加，
    // 等长即没变）——都不用读内容。本机 686 条已导入的 pi 会话，重扫时绝大多数停在这里
    if (copies.length > 0 && (bytes === null || (await someCopyHasSize(copies, bytes)))) {
      skip(entry.id, entry.title || null, "already-imported");
      continue;
    }
    if (bytes === null) {
      skip(entry.id, entry.title || null, "missing-file", entry.piSessionFile);
      continue;
    }

    let source: PiSource;
    try {
      source = await readPiSource(entry.piSessionFile, deps.promaRoot, deps.extraSourceRoots ?? []);
    } catch (cause) {
      if (copies.length > 0) {
        // 导过、现在源读不了：orbita 里那份照留，这次不动它
        skip(entry.id, entry.title || null, "already-imported");
      } else {
        skip(entry.id, entry.title || null, "bad-session-file", cause instanceof Error ? cause.message : String(cause));
      }
      continue;
    }
    const sessionEntries = source.entries.filter(
      (fileEntry): fileEntry is SessionEntry => fileEntry.type !== "session",
    );

    let change: ImportChange = freshChange(entry.piSessionFile);
    let newMessages = 0;
    /** diverged：另导的一份落在原会话旁边（同工作区、同 cwd），不走去向解析 */
    let besideOriginal: SessionMeta | null = null;
    if (copies.length > 0) {
      const state = reimportState(sessionEntries, await readCopies(copies));
      if (state.kind === "unchanged") {
        skip(entry.id, entry.title || null, "already-imported");
        continue;
      }
      if (state.kind === "updated") {
        totalBytes += bytes;
        plan.push(updatedPlanItem(entry, state.meta, state.newMessages, sessionEntries, bytes));
        continue;
      }
      change = "diverged";
      newMessages = state.newMessages;
      besideOriginal = state.meta;
    } else {
      // 「只随手发了一句」检查的候选：只看没导过的（导过的怎么变都走上面的再次导入）
      const only = await promaOnlyMessage(sessionEntries, deps.promaRoot, entry.id);
      if (only !== null) singleMessages.set(entry.piSessionFile, only);
    }

    let resolution: { folder: string | null; workspaceId: string | null; cwd: string };
    if (besideOriginal !== null) {
      resolution = { folder: null, workspaceId: besideOriginal.workspaceId, cwd: besideOriginal.cwd };
    } else {
      const resolved = applyDestination(
        await resolveWorkspaceTarget(entry.workspaceId, promaWorkspaces, deps.workspaces, source.headerCwd, deps),
        overrides,
        deps,
      );
      if (resolved.create !== null) {
        // 同一个 Proma 工作区的多条会话共享一次新建（path 为键），id 对齐到第一份计划
        const existing = newWorkspaceByKey.get(resolved.create.path);
        if (existing === undefined) {
          newWorkspaceByKey.set(resolved.create.path, resolved.create);
        } else {
          resolved.workspaceId = existing.id;
        }
      }
      if (resolved.mergedInto !== null) mergedIds.add(resolved.mergedInto);
      resolution = resolved;
    }

    // 模型：索引的 modelId 优先，缺失时从 pi 文件补（最后的 model_change / assistant model）
    const promaModelId = entry.modelId ?? modelFromEntries(sessionEntries);
    const mapped = mapModel(promaModelId, deps.registeredModels, deps.fallbackModel);
    if (!mapped.matched) modelFallbackCount += 1;

    totalBytes += bytes;
    plan.push({
      sourceId: entry.id,
      source: "proma",
      sourceKind: "pi",
      change,
      newMessages,
      folder: resolution.folder,
      sourceFile: entry.piSessionFile,
      // 会话 id 在工作区解析**之后**铸：新建工作区的 id 也走 newId，消耗顺序是测试预铸队列的契约
      sessionId: deps.newId(),
      // 子会话在计划成形后统一回填（linkSubSessions）：母会话可能排在后面、还没铸 id
      parentId: null,
      title: deriveSessionTitle(entry.title),
      workspaceId: resolution.workspaceId,
      cwd: resolution.cwd,
      providerId: mapped.providerId,
      modelId: mapped.modelId,
      importedModel: promaModelId,
      modelMatched: mapped.matched,
      archived: entry.archived,
      pinned: entry.pinned,
      starred: entry.starred,
      createdAt: entry.createdAt ?? (source.headerTimestamp || Date.now()),
      updatedAt: qaTime(
        lastQaTimestamp(sessionEntries),
        entry.createdAt,
        entry.updatedAt ?? entry.createdAt ?? (source.headerTimestamp || Date.now()),
      ),
      bytes,
    });
  }

  // —— claude legacy 条目：渲染 JSONL 转换导入（源文件按 <promaRoot>/agent-sessions/<id>.jsonl 推导） ——
  for (const entry of promaSessions.claudeEntries) {
    const sourceFile = claudeSourceFile(deps.promaRoot, entry.id);
    // 导过就不会再变：Proma 的 Claude 时代会话是只读历史，不能续聊也不能回退
    // （Proma agent-orchestrator.ts 的 legacyTranscript.continuationRequired 拦截）
    if (importedBySource.has(sourceFile)) {
      skip(entry.id, entry.title || null, "already-imported");
      continue;
    }
    if (seenSources.has(sourceFile)) {
      skip(
        entry.id,
        entry.title || null,
        "already-imported",
        "another index entry with the same source file is already in the plan",
      );
      continue;
    }
    seenSources.add(sourceFile);

    let raw: string;
    let bytes: number;
    try {
      bytes = (await stat(sourceFile)).size;
      raw = await readFile(sourceFile, "utf8");
    } catch {
      skip(entry.id, entry.title || null, "missing-file", sourceFile);
      continue;
    }
    // 扫描期做完整清洗（不是只看文件在不在）：转换不出 assistant 消息的文件
    // （纯旧扁平 / 空 draft）现在就剔除，不留到执行时报 failed
    const { rows } = parseClaudeRows(raw);
    // 「只随手发了一句」检查的候选。源就是界面日志，用户行即原文
    const only = onlyWrittenMessage(promaUserTexts(raw));
    if (only !== null) singleMessages.set(sourceFile, only);
    if (!hasAssistantRow(rows)) {
      skip(
        entry.id,
        entry.title || null,
        "unsupported-format",
        "no assistant messages to convert (old flat format or empty)",
      );
      continue;
    }

    // claude legacy 没有 pi header：无归属时 cwd 直接落 defaultCwd（usableCwd 对空串的行为）
    const resolution = applyDestination(
      await resolveWorkspaceTarget(entry.workspaceId, promaWorkspaces, deps.workspaces, "", deps),
      overrides,
      deps,
    );
    if (resolution.create !== null) {
      const existing = newWorkspaceByKey.get(resolution.create.path);
      if (existing === undefined) {
        newWorkspaceByKey.set(resolution.create.path, resolution.create);
      } else {
        resolution.workspaceId = existing.id;
      }
    }
    if (resolution.mergedInto !== null) mergedIds.add(resolution.mergedInto);

    // 模型：索引的 modelId 优先（只有 30/257 条有），缺失时从清洗后的行取最后的 assistant model
    const promaModelId = entry.modelId ?? lastModelFromRows(rows);
    const mapped = mapModel(promaModelId, deps.registeredModels, deps.fallbackModel);
    if (!mapped.matched) modelFallbackCount += 1;

    const createdAt = entry.createdAt ?? firstTimestamp(rows) ?? Date.now();
    totalBytes += bytes;
    plan.push({
      sourceId: entry.id,
      source: "proma",
      sourceKind: "claude-legacy",
      change: freshChange(sourceFile),
      newMessages: 0,
      folder: resolution.folder,
      sourceFile,
      sessionId: deps.newId(),
      // claude legacy 时代也有 delegation 子会话（本机 20 条），同样由 linkSubSessions 回填
      parentId: null,
      title: deriveSessionTitle(entry.title),
      workspaceId: resolution.workspaceId,
      cwd: resolution.cwd,
      providerId: mapped.providerId,
      modelId: mapped.modelId,
      importedModel: promaModelId,
      modelMatched: mapped.matched,
      archived: entry.archived,
      pinned: entry.pinned,
      starred: entry.starred,
      createdAt,
      updatedAt: qaTime(lastRowTimestamp(rows), entry.createdAt, entry.updatedAt ?? entry.createdAt ?? createdAt),
      bytes,
    });
  }

  // —— 转换类来源（Claude Code、Kimi Code、opencode）：在 Proma 之后扫，同一文件夹复用 Proma 已计划新建的
  //    工作区；「这次有两条及以上就新建工作区」跨来源计数 ——
  const converted: ConvertedCandidate[] = [];
  if (sources.includes("claude-code") && deps.claudeCode !== undefined) {
    const found = await scanClaudeCode(deps.claudeCode, deps, importedBySource);
    skipped.push(...found.skipped);
    converted.push(...found.candidates);
  }
  if (sources.includes("kimi-code") && deps.kimiCode !== undefined) {
    const found = await scanKimiCode(deps.kimiCode, deps, importedBySource);
    skipped.push(...found.skipped);
    converted.push(...found.candidates);
  }
  if (sources.includes("opencode") && deps.opencode !== undefined) {
    const found = await scanOpencode(deps.opencode, deps, importedBySource);
    skipped.push(...found.skipped);
    converted.push(...found.candidates);
  }
  if (sources.includes("reasonix") && deps.reasonix !== undefined) {
    const found = await scanReasonix(deps.reasonix, deps, importedBySource);
    skipped.push(...found.skipped);
    converted.push(...found.candidates);
  }
  for (const candidate of await placeConverted(converted, deps, newWorkspaceByKey)) {
    const resolution = applyDestination(candidate.resolution, overrides, deps);
    if (resolution.create !== null) {
      const existing = newWorkspaceByKey.get(resolution.create.path);
      if (existing === undefined) {
        newWorkspaceByKey.set(resolution.create.path, resolution.create);
      } else {
        resolution.workspaceId = existing.id;
      }
    }
    if (resolution.mergedInto !== null) mergedIds.add(resolution.mergedInto);
    const mapped = mapModel(candidate.model, deps.registeredModels, deps.fallbackModel);
    if (!mapped.matched) modelFallbackCount += 1;
    totalBytes += candidate.bytes;
    if (candidate.onlyMessage !== null) singleMessages.set(candidate.sourceFile, candidate.onlyMessage);
    plan.push({
      sourceId: candidate.sourceId,
      source: candidate.source,
      sourceKind: candidate.sourceKind,
      change: freshChange(candidate.sourceFile),
      newMessages: 0,
      folder: resolution.folder,
      sourceFile: candidate.sourceFile,
      sessionId: deps.newId(),
      parentId: null,
      title: candidate.title,
      workspaceId: resolution.workspaceId,
      cwd: resolution.cwd,
      providerId: mapped.providerId,
      modelId: mapped.modelId,
      importedModel: candidate.model,
      modelMatched: mapped.matched,
      // 迁移边界（2026-09-24）：不适配源应用的会话管理功能（桌面应用的归档也不跟）
      archived: false,
      pinned: false,
      starred: false,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      bytes: candidate.bytes,
    });
  }

  const { subSessionCount, orphanedSubSessions } = linkSubSessions(
    plan,
    parentSourceById,
    sourceFileById,
    deps.existingMetas,
  );
  // 子会话对齐母会话的工作区之后，它自己解析出的新建 / 合并工作区可能已无人引用——
  // 只留被引用的，否则执行会建出一个空工作区
  const referenced = new Set(plan.map((item) => item.workspaceId));

  // 创建时间升序：执行按这个顺序落盘，时间线自然有序
  plan.sort((a, b) => a.createdAt - b.createdAt || a.sourceId.localeCompare(b.sourceId));

  // 「只随手发了一句」检查的候选：页面上能单独勾的新会话（跟着母会话走的子会话不算）
  const planIds = new Set(plan.map((item) => item.sessionId));
  const greetingCandidates = new Map<string, string>();
  for (const item of plan) {
    const only = singleMessages.get(item.sourceFile);
    if (only === undefined || item.change === "updated" || item.change === "diverged") continue;
    if (isSelectablePlanItem(item, planIds)) greetingCandidates.set(item.sourceFile, only);
  }

  // skills：组的顺序就是重名先到先得的顺序——Proma 各工作区 → 共用目录 → Claude Code
  const promaFolders = sources.includes("proma") ? await promaWorkspaceFolders(deps.promaRoot) : [];
  const skillDirs: SkillSourceDir[] = promaSkillDirs(deps.promaRoot, promaFolders);
  if (sources.includes("agent-skills") && deps.agentSkillsDir !== undefined) {
    skillDirs.push({ source: "agent-skills", name: null, dir: deps.agentSkillsDir });
  }
  if (sources.includes("claude-code") && deps.claudeCode !== undefined) {
    skillDirs.push(...(await claudeCodeSkillDirs(deps.claudeCode.skillsDir)));
  }
  const skills =
    skillDirs.length === 0
      ? []
      : await scanSkillDirs(
          skillDirs,
          new Set(deps.existingSkills ?? []),
          sources.includes("proma") ? await promaBuiltInSkills(deps.promaRoot) : new Set<string>(),
        );

  // MCP：同名取先到的配置——Proma（按工作区顺序）→ Claude Code（全局 → 各项目）→ Kimi Code → opencode
  const mcpEntries: McpSourceEntry[] = await readPromaMcp(deps.promaRoot, promaFolders);
  if (sources.includes("claude-code") && deps.claudeCode !== undefined) {
    mcpEntries.push(...(await readClaudeCodeMcp(deps.claudeCode.claudeJson)));
  }
  if (sources.includes("kimi-code") && deps.kimiCode !== undefined) {
    mcpEntries.push(...(await readKimiCodeMcp(deps.kimiCode.mcpFile)));
  }
  if (sources.includes("opencode") && deps.opencode !== undefined) {
    mcpEntries.push(...(await readOpencodeMcp(deps.opencode.configFile)));
  }
  const mcp = mergeMcpEntries(mcpEntries, new Set(deps.existingMcp ?? []));

  const report: ImportScanReport = {
    plan,
    newWorkspaces: [...newWorkspaceByKey.values()].filter((workspace) => referenced.has(workspace.id)),
    mergedWorkspaceIds: [...mergedIds].filter((id) => referenced.has(id)),
    skipped,
    withoutPiSession: promaSessions.withoutPiFile,
    totalBytes,
    modelFallbackCount,
    subSessionCount,
    orphanedSubSessions,
    lastImportAt: ledger.reduce<number | null>(
      (latest, line) => (line.at !== null && (latest === null || line.at > latest) ? line.at : latest),
      null,
    ),
    skills,
    mcp: mcp.items,
    greetingCheck: { candidates: greetingCandidates.size, model: deps.greetingModel ?? null },
  };
  return { report, mcpServers: mcp.servers, greetingCandidates };
}

/** 一个来源都没勾时的扫描结果：什么都没读，也就什么都没有。 */
export function emptyScanReport(): ImportScanReport {
  return {
    plan: [],
    newWorkspaces: [],
    mergedWorkspaceIds: [],
    skipped: [],
    withoutPiSession: 0,
    totalBytes: 0,
    modelFallbackCount: 0,
    subSessionCount: 0,
    orphanedSubSessions: 0,
    lastImportAt: null,
    skills: [],
    mcp: [],
    greetingCheck: { candidates: 0, model: null },
  };
}

/** claude legacy 条目的源文件路径（索引里没有，按 Proma 的目录惯例推导）。 */
function claudeSourceFile(promaRoot: string, id: string): string {
  return join(promaRoot, "agent-sessions", `${id}.jsonl`);
}

// ---------------------------------------------------------------------------
// 转换类来源（Claude Code、Kimi Code）共用：候选与默认去向
// ---------------------------------------------------------------------------

/** 一条待导入的转换类会话：计划条目除去模型映射与去向之外的全部原料。 */
interface ConvertedCandidate {
  /** 用户唯一写过的那条（「只随手发了一句」检查的候选）；写过零条或不止一条为 null */
  onlyMessage: string | null;
  source: ImportSourceId;
  sourceKind: ImportSourceKind;
  sourceId: string;
  sourceFile: string;
  title: string;
  /** 最后一条 assistant 的模型 id */
  model: string | null;
  createdAt: number;
  updatedAt: number;
  bytes: number;
  /** 源侧文件夹（sessionFolder 的产物：家目录、不在盘上的为 null）与续聊用的 cwd */
  folder: string | null;
  cwd: string;
}

/**
 * 默认去向（还没盖用户的覆盖）。文件夹与 orbita 工作区同址 → 挂上去；Proma 这次要建同路径的
 * 工作区 → 共用；这次有两条及以上（跨来源计）→ 新建工作区；只有一条 → Tasks，cwd 仍是那个
 * 文件夹（裁决 #9）。
 */
async function placeConverted(
  found: readonly ConvertedCandidate[],
  deps: ImporterDeps,
  plannedWorkspaces: ReadonlyMap<string, ImportWorkspacePlan>,
): Promise<(ConvertedCandidate & { resolution: WorkspaceResolution })[]> {
  const perFolder = new Map<string, number>();
  for (const item of found) {
    if (item.folder !== null) perFolder.set(item.folder, (perFolder.get(item.folder) ?? 0) + 1);
  }
  const orbitaPaths = await Promise.all(
    deps.workspaces.map(async (workspace) => ({ workspace, path: await normalizeForMatch(workspace.path) })),
  );
  const minted = new Map<string, ImportWorkspacePlan>();
  const placed: (ConvertedCandidate & { resolution: WorkspaceResolution })[] = [];
  for (const item of found) {
    const { folder, cwd } = item;
    let resolution: WorkspaceResolution;
    if (folder === null) {
      resolution = { workspaceId: null, cwd, folder: null, create: null, mergedInto: null };
    } else {
      const wanted = await normalizeForMatch(folder);
      const same = orbitaPaths.find((candidate) => candidate.path === wanted)?.workspace;
      const planned = plannedWorkspaces.get(folder) ?? minted.get(folder);
      if (same !== undefined) {
        resolution = { workspaceId: same.id, cwd: same.path, folder, create: null, mergedInto: same.id };
      } else if (planned !== undefined) {
        resolution = { workspaceId: planned.id, cwd: folder, folder, create: planned, mergedInto: null };
      } else if ((perFolder.get(folder) ?? 0) >= 2) {
        const create: ImportWorkspacePlan = { id: deps.newId(), name: deriveWorkspaceName(folder), path: folder, merged: false };
        minted.set(folder, create);
        resolution = { workspaceId: create.id, cwd: folder, folder, create, mergedInto: null };
      } else {
        resolution = { workspaceId: null, cwd: folder, folder, create: null, mergedInto: null };
      }
    }
    placed.push({ ...item, resolution });
  }
  return placed;
}

/**
 * 会话的文件夹与续聊用的 cwd。家目录不算文件夹（cwd 仍是它）；不在盘上的文件夹
 * （删掉的 worktree、别的应用的临时工作目录）既不算文件夹也不能当 cwd，退 defaultCwd。
 */
async function sessionFolder(
  path: string | null,
  home: string,
  defaultCwd: string,
): Promise<{ folder: string | null; cwd: string }> {
  if (path === null) return { folder: null, cwd: defaultCwd };
  const resolved = resolve(path);
  let isDirectory = false;
  try {
    isDirectory = (await stat(resolved)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return { folder: null, cwd: defaultCwd };
  if (resolved === resolve(home)) return { folder: null, cwd: resolved };
  return { folder: resolved, cwd: resolved };
}

// ---------------------------------------------------------------------------
// Claude Code 来源
// ---------------------------------------------------------------------------

/**
 * 扫 Claude Code 的会话文件，产出候选与跳过项。
 *
 * **哪些文件是一条会话**：Claude 桌面应用每次续接旧会话都另起一个文件、把历史整段复制过去
 * （本机「Handoff UI」一条会话 4 个文件）。按桌面应用的会话清单归并：
 * - 清单里 priorCliSessionIds 列出的旧文件不列（内容已在最新的文件里）；
 * - 没被清单引用、首条消息却与某个清单文件相同的，是桌面应用里已经不在的分叉（本机 4 个），
 *   同样不列。
 * 两类都不进跳过清单：在源应用里它们就不是一条会话。命令行的会话不在清单里，一个文件一条。
 *
 * **文件夹** = 桌面清单的 originCwd，其次会话文件里的 cwd；去向由 placeConverted 统一定。
 *
 * 导过的一律 already-imported：再次导入（追加 Claude Code 里的新消息）没做——副本是转换
 * 构造的，entry id 与源对不上，Proma 那套按 id 对齐的判法用不了。
 */
async function scanClaudeCode(
  paths: ClaudeCodePaths,
  deps: ImporterDeps,
  importedBySource: ReadonlyMap<string, readonly SessionMeta[]>,
): Promise<{ candidates: ConvertedCandidate[]; skipped: ImportSkipItem[] }> {
  const files = await listClaudeCodeFiles(paths.projectsDir);
  const desktop = await readClaudeDesktopSessions(paths.desktopSessionsDir);
  const listed = new Map(desktop.map((entry) => [entry.cliSessionId, entry]));
  const superseded = new Set(desktop.flatMap((entry) => entry.priorCliSessionIds));
  const listedRoots = new Set<string>();
  for (const file of files) {
    if (!listed.has(claudeCodeSessionId(file))) continue;
    const root = await readClaudeCodeRootUuid(file);
    if (root !== null) listedRoots.add(root);
  }

  const skipped: ImportSkipItem[] = [];
  const candidates: ConvertedCandidate[] = [];
  for (const file of files) {
    const sourceId = claudeCodeSessionId(file);
    if (superseded.has(sourceId)) continue;
    const entry = listed.get(sourceId);
    if (importedBySource.has(file)) {
      skipped.push({ sourceId, title: entry?.title ?? null, reason: "already-imported" });
      continue;
    }
    let raw: string;
    let bytes: number;
    try {
      bytes = (await stat(file)).size;
      raw = await readFile(file, "utf8");
    } catch {
      skipped.push({ sourceId, title: entry?.title ?? null, reason: "missing-file", detail: file });
      continue;
    }
    const session = parseClaudeCodeSession(raw);
    if (entry === undefined && session.rootUuid !== null && listedRoots.has(session.rootUuid)) continue;
    const title = deriveSessionTitle(entry?.title ?? session.title ?? session.firstPrompt ?? "") || "Claude Code session";
    const converted = claudeRowsToMessages(session.rows, "scan");
    // 按执行时同一条转换判断：没有 assistant 消息 pi 不落盘（只发了一句就断掉的会话）
    if (!converted.messages.some((message) => message.role === "assistant")) {
      skipped.push({ sourceId, title, reason: "unsupported-format", detail: "no assistant messages to convert" });
      continue;
    }
    const place = await sessionFolder(entry?.folder ?? session.cwd, paths.home, deps.defaultCwd);
    const createdAt = entry?.createdAt ?? firstTimestamp(session.rows) ?? Date.now();
    candidates.push({
      onlyMessage: onlyWrittenMessage(converted.userRowIndexes.map((row) => session.displays[row] ?? null)),
      source: "claude-code",
      sourceKind: "claude-code",
      sourceId,
      sourceFile: file,
      title,
      model: lastModelFromRows(session.rows),
      createdAt,
      updatedAt: qaTime(lastRowTimestamp(session.rows), createdAt, createdAt),
      bytes,
      ...place,
    });
  }

  return { candidates, skipped };
}

function claudeCodeSessionId(file: string): string {
  return basename(file, ".jsonl");
}

/** projects 下每个项目目录里的顶层 .jsonl（子代理文件在更深一层，不列）。根目录不在 = 没有会话。 */
async function listClaudeCodeFiles(projectsDir: string): Promise<string[]> {
  let projects;
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const files: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(projectsDir, project.name);
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(dir, file.name));
    }
  }
  return files.sort();
}

/** 桌面应用的会话清单：<目录>/<账户>/<组织>/local_*.json。目录不在、单条坏了都跳过。 */
async function readClaudeDesktopSessions(dir: string): Promise<ClaudeDesktopSession[]> {
  const out: ClaudeDesktopSession[] = [];
  const subdirs = async (path: string): Promise<string[]> => {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(path, entry.name));
    } catch {
      return [];
    }
  };
  for (const account of await subdirs(dir)) {
    for (const org of await subdirs(account)) {
      let names: string[];
      try {
        names = await readdir(org);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith("local_") || !name.endsWith(".json")) continue;
        try {
          const parsed = parseClaudeDesktopSession(await readFile(join(org, name), "utf8"));
          if (parsed !== null) out.push(parsed);
        } catch {
          // 读不了的一条：它指向的文件按命令行会话处理
        }
      }
    }
  }
  return out;
}

/** 首条消息的 uuid：先读文件开头 512KB，没找到再读整份（开头可能是大段附件行）。 */
async function readClaudeCodeRootUuid(file: string): Promise<string | null> {
  const HEAD = 512 * 1024;
  try {
    const handle = await open(file, "r");
    let head: string;
    let size: number;
    try {
      size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(HEAD, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const root = claudeCodeRootUuid(head);
    if (root !== null || size <= HEAD) return root;
    return claudeCodeRootUuid(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kimi Code 来源
// ---------------------------------------------------------------------------

/** 一条 Kimi Code 会话的对话文件（会话目录下 agents/main/wire.jsonl）：也是幂等键。 */
function kimiWireFile(sessionDir: string): string {
  return join(sessionDir, "agents", "main", "wire.jsonl");
}

/** Kimi Code 的工作区表：工作区 id → root，以及在源里删掉的工作区。读不了 = 都没有。 */
async function readKimiWorkspaces(file: string): Promise<{ roots: Map<string, string>; deleted: Set<string> }> {
  const roots = new Map<string, string>();
  const deleted = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { roots, deleted };
  }
  const record = asRecord(parsed);
  const workspaces = asRecord(record?.["workspaces"]);
  for (const [id, value] of Object.entries(workspaces ?? {})) {
    const root = optionalString(asRecord(value)?.["root"]);
    if (root !== null) roots.set(id, root);
  }
  const removed = record?.["deleted_workspace_ids"];
  if (Array.isArray(removed)) {
    for (const id of removed) if (typeof id === "string") deleted.add(id);
  }
  return { roots, deleted };
}

/**
 * 扫 Kimi Code 的会话：`sessions/<工作区 id>/<会话 id>/` 一个目录一条（点开头的是 Kimi 自己的
 * 索引缓存）。源里删掉的工作区（workspaces.json 的 deleted_workspace_ids）下的会话不列。
 *
 * 标题：Kimi 显示的标题（新建未命名的「New Session」不算）> 第一句用户写的话 > 「Kimi Code session」。
 * 文件夹：state.json 的 cwd，旧版没记的取所属工作区的 root；去向由 placeConverted 统一定。
 * 导过的一律 already-imported：与 Claude Code 同理，副本是转换构造的，再次导入没做。
 */
async function scanKimiCode(
  paths: KimiCodePaths,
  deps: ImporterDeps,
  importedBySource: ReadonlyMap<string, readonly SessionMeta[]>,
): Promise<{ candidates: ConvertedCandidate[]; skipped: ImportSkipItem[] }> {
  const candidates: ConvertedCandidate[] = [];
  const skipped: ImportSkipItem[] = [];
  let workspaceDirs;
  try {
    workspaceDirs = await readdir(paths.sessionsDir, { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return { candidates, skipped };
    throw cause;
  }
  const workspaces = await readKimiWorkspaces(paths.workspacesFile);
  for (const workspace of workspaceDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!workspace.isDirectory() || workspace.name.startsWith(".") || workspaces.deleted.has(workspace.name)) continue;
    const workspaceDir = join(paths.sessionsDir, workspace.name);
    const sessions = (await readdir(workspaceDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const session of sessions) {
      if (!session.isDirectory() || session.name.startsWith(".")) continue;
      const dir = join(workspaceDir, session.name);
      const sourceId = session.name;
      const sourceFile = kimiWireFile(dir);
      let state = null;
      try {
        state = parseKimiSessionState(await readFile(join(dir, "state.json"), "utf8"));
      } catch {
        // 没有 state.json：标题与时间从对话里取
      }
      if (importedBySource.has(sourceFile)) {
        skipped.push({ sourceId, title: state?.title ?? null, reason: "already-imported" });
        continue;
      }
      let raw: string;
      let bytes: number;
      try {
        bytes = (await stat(sourceFile)).size;
        raw = await readFile(sourceFile, "utf8");
      } catch {
        skipped.push({ sourceId, title: state?.title ?? null, reason: "missing-file", detail: sourceFile });
        continue;
      }
      // 扫描不读图片（只判能不能转、取标题与模型）；执行时再读 blobs
      const wire = parseKimiWire(raw, "scan", new Map());
      const title = deriveSessionTitle(state?.title ?? wire.firstPrompt ?? "") || "Kimi Code session";
      if (!wire.messages.some((message) => message.role === "assistant")) {
        skipped.push({ sourceId, title, reason: "unsupported-format", detail: "no assistant messages to convert" });
        continue;
      }
      const place = await sessionFolder(state?.cwd ?? workspaces.roots.get(workspace.name) ?? null, paths.home, deps.defaultCwd);
      const createdAt = state?.createdAt ?? wire.firstAt ?? Date.now();
      candidates.push({
        onlyMessage: onlyWrittenMessage(wire.userDisplays),
        source: "kimi-code",
        sourceKind: "kimi-code",
        sourceId,
        sourceFile,
        title,
        model: wire.model,
        createdAt,
        updatedAt: qaTime(wire.lastAt, createdAt, createdAt),
        bytes,
        ...place,
      });
    }
  }
  return { candidates, skipped };
}

// ---------------------------------------------------------------------------
// opencode 来源
// ---------------------------------------------------------------------------

/** opencode 会话的幂等键：库里没有会话文件，写成「库路径#会话 id」。 */
function opencodeSourceKey(dbFile: string, sessionId: string): string {
  return `${resolve(dbFile)}#${sessionId}`;
}

/**
 * 扫 opencode 的库：根会话一条一条（子会话是 task 工具派出去的子 agent，不列）。与执行同一条
 * 转换判断能不能导（整库 70 条会话的读取与转换本机约 200ms）。
 *
 * 标题：opencode 的标题（默认的「New session - 时间」不算）> 第一句用户写的话 > 「opencode session」。
 * 文件夹：会话的 directory；去向由 placeConverted 统一定。导过的一律 already-imported（副本是
 * 转换构造的，再次导入没做）。库打不开（格式不认识、被锁）整次扫描报错，不静默当成没有会话。
 */
async function scanOpencode(
  paths: OpencodePaths,
  deps: ImporterDeps,
  importedBySource: ReadonlyMap<string, readonly SessionMeta[]>,
): Promise<{ candidates: ConvertedCandidate[]; skipped: ImportSkipItem[] }> {
  const candidates: ConvertedCandidate[] = [];
  const skipped: ImportSkipItem[] = [];
  try {
    await stat(paths.dbFile);
  } catch (cause) {
    if (isNotFound(cause)) return { candidates, skipped };
    throw cause;
  }
  const found = withOpencodeDb(paths.dbFile, (db) =>
    readOpencodeSessions(db).map((session) => {
      const sourceFile = opencodeSourceKey(paths.dbFile, session.id);
      if (importedBySource.has(sourceFile)) return { session, sourceFile, parsed: null, bytes: 0 };
      return {
        session,
        sourceFile,
        parsed: opencodeToMessages(readOpencodeMessages(db, session.id), "scan", session.revert),
        bytes: opencodeSessionBytes(db, session.id),
      };
    }),
  );
  for (const { session, sourceFile, parsed, bytes } of found) {
    if (parsed === null) {
      skipped.push({ sourceId: session.id, title: session.title, reason: "already-imported" });
      continue;
    }
    const title = deriveSessionTitle(session.title ?? parsed.firstPrompt ?? "") || "opencode session";
    if (!parsed.messages.some((message) => message.role === "assistant")) {
      skipped.push({ sourceId: session.id, title, reason: "unsupported-format", detail: "no assistant messages to convert" });
      continue;
    }
    const place = await sessionFolder(session.directory, paths.home, deps.defaultCwd);
    const createdAt = session.createdAt || parsed.firstAt || Date.now();
    candidates.push({
      onlyMessage: onlyWrittenMessage(parsed.userDisplays),
      source: "opencode",
      sourceKind: "opencode",
      sourceId: session.id,
      sourceFile,
      title,
      model: parsed.model,
      createdAt,
      updatedAt: qaTime(parsed.lastAt, createdAt, session.updatedAt || createdAt),
      bytes,
      ...place,
    });
  }
  return { candidates, skipped };
}

/**
 * 扫 Reasonix 桌面版的会话库：projects/<项目>/sessions/*.jsonl 一条一条。与执行同一条转换
 * 判断能不能导（本机 326 条 / 304 MB 全量读取与转换实测 <1s——扫描有进度提示兜着）。
 *
 * 标题：meta 的 topic_title > 第一句用户写的话 > 「Reasonix session」。模型在 meta 上
 * （源行上没有 per-message 模型）。文件夹：meta 的 workspace_root。转换器见 reasonix.ts。
 * 根不在（没装）listReasonixSessions 返回空，不算错。
 */
async function scanReasonix(
  paths: ReasonixPaths,
  deps: ImporterDeps,
  importedBySource: ReadonlyMap<string, readonly SessionMeta[]>,
): Promise<{ candidates: ConvertedCandidate[]; skipped: ImportSkipItem[] }> {
  const candidates: ConvertedCandidate[] = [];
  const skipped: ImportSkipItem[] = [];
  for (const { file, meta, bytes } of await listReasonixSessions(paths.projectsRoot)) {
    const sourceFile = resolve(file);
    const sourceId = meta?.id ?? file;
    const title0 = meta?.title ?? null;
    if (importedBySource.has(sourceFile)) {
      skipped.push({ sourceId, title: title0, reason: "already-imported" });
      continue;
    }
    let parsed: ReturnType<typeof reasonixToMessages>;
    try {
      const raw = await readFile(sourceFile, "utf8");
      parsed = reasonixToMessages(parseReasonixRows(raw).rows, "scan", meta?.model ?? null);
    } catch (cause) {
      skipped.push({
        sourceId,
        title: title0,
        reason: "bad-session-file",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }
    if (!parsed.messages.some((message) => message.role === "assistant")) {
      skipped.push({ sourceId, title: title0, reason: "unsupported-format", detail: "no assistant messages to convert" });
      continue;
    }
    const title = deriveSessionTitle(title0 ?? parsed.firstPrompt ?? "") || "Reasonix session";
    const place = await sessionFolder(meta?.workspaceRoot ?? null, paths.home, deps.defaultCwd);
    const createdAt = meta?.createdAt ?? parsed.firstAt ?? Date.now();
    candidates.push({
      onlyMessage: onlyWrittenMessage(parsed.userDisplays),
      source: "reasonix",
      sourceKind: "reasonix",
      sourceId,
      sourceFile,
      title,
      model: meta?.model ?? null,
      createdAt,
      updatedAt: meta?.updatedAt ?? qaTime(parsed.lastAt, createdAt, createdAt),
      bytes,
      ...place,
    });
  }
  return { candidates, skipped };
}

// ---------------------------------------------------------------------------
// 子会话挂回母会话
// ---------------------------------------------------------------------------

/** 母会话在 orbita 这边的坐标：子会话按它挂 parentId、对齐工作区与 cwd。 */
interface ParentTarget {
  sessionId: string;
  workspaceId: string | null;
  cwd: string;
  /** 母会话在本次计划里时是它的分组键；已导入的母会话没有（子会话保留自己的） */
  folder?: string | null;
}

/**
 * 把 Proma 的 delegation 父子关系（索引的 `parentSessionId`）翻成 orbita 的 parentId。
 * 扫描期就定，执行照计划落——报告才说得出「谁挂在谁下」。**就地改 plan 条目**。
 *
 * 母会话按序找：① 在本次计划里 → 它扫描期铸好的 sessionId；② 此前已导入（existing meta
 * 的 importedFrom == 母会话的源文件）→ 那条 orbita 会话——分两次导、或母会话上次失败这次重导，
 * 子会话照样挂得回去；③ 都不是（母会话无可导文件 / 坏文件 / 索引里已没有）→ 按根会话导、
 * 计入 orphanedSubSessions，数据不丢。
 *
 * **多层拍平到根祖先**：orbita 的 UI 只做一层（SessionMeta.parentId 的裁决），孙会话挂在
 * 子会话下就得先打开子会话才找得到；Proma 自己也不让子会话再派（本机 284 条
 * delegationDepth 全是 1）。沿源里的父链走到没有父的那条为止；链里成环 → 按孤儿处理
 * （成环的一组 parentId 互指，rootSessions 会把它们全部滤出左栏，等于数据丢了）。
 *
 * 子会话**对齐母会话的工作区与 cwd**（同一工作区是 orbita 子会话的契约；本机 284/284
 * 本来就同工作区，对齐是防御），pinned / starred / archived 置 false——子会话没有生命周期，
 * 只从母会话的右栏到达。
 */
function linkSubSessions(
  plan: ImportPlanItem[],
  parentSourceById: ReadonlyMap<string, string>,
  sourceFileById: ReadonlyMap<string, string>,
  existingMetas: readonly SessionMeta[],
): { subSessionCount: number; orphanedSubSessions: number } {
  const planBySourceId = new Map(plan.map((item) => [item.sourceId, item]));
  const importedByFile = new Map<string, SessionMeta>();
  for (const meta of existingMetas) {
    if (meta.importedFrom !== undefined) importedByFile.set(meta.importedFrom, meta);
  }

  /** 沿父链走到根祖先的 Proma id；成环返回 null。调用方保证 sourceId 有父。 */
  const rootAncestor = (sourceId: string): string | null => {
    const seen = new Set([sourceId]);
    let current = parentSourceById.get(sourceId);
    while (current !== undefined) {
      const next = parentSourceById.get(current);
      if (next === undefined) return current;
      if (seen.has(current)) return null;
      seen.add(current);
      current = next;
    }
    return null;
  };

  const findParent = (rootSourceId: string): ParentTarget | null => {
    const inPlan = planBySourceId.get(rootSourceId);
    if (inPlan !== undefined) {
      return { sessionId: inPlan.sessionId, workspaceId: inPlan.workspaceId, cwd: inPlan.cwd, folder: inPlan.folder };
    }
    const sourceFile = sourceFileById.get(rootSourceId);
    const imported = sourceFile === undefined ? undefined : importedByFile.get(sourceFile);
    if (imported !== undefined) {
      return { sessionId: imported.id, workspaceId: imported.workspaceId, cwd: imported.cwd };
    }
    return null;
  };

  let subSessionCount = 0;
  let orphanedSubSessions = 0;
  for (const item of plan) {
    // 追加的既有会话已经挂在该挂的地方（parentId 取自它自己的 meta），不重新挂
    if (item.change === "updated" || !parentSourceById.has(item.sourceId)) continue;
    const rootSourceId = rootAncestor(item.sourceId);
    const target = rootSourceId === null ? null : findParent(rootSourceId);
    if (target === null) {
      orphanedSubSessions += 1;
      continue;
    }
    item.parentId = target.sessionId;
    item.workspaceId = target.workspaceId;
    item.cwd = target.cwd;
    if (target.folder !== undefined) item.folder = target.folder;
    item.pinned = false;
    item.starred = false;
    item.archived = false;
    subSessionCount += 1;
  }
  return { subSessionCount, orphanedSubSessions };
}

// ---------------------------------------------------------------------------
// 再次导入：与 orbita 的副本对齐
// ---------------------------------------------------------------------------

/** 源文件与某份 orbita 副本等长 = 没变（pi 文件只追加；导入时是原字节复制）。 */
async function someCopyHasSize(copies: readonly SessionMeta[], bytes: number): Promise<boolean> {
  for (const meta of copies) {
    if (meta.piSessionFile === null) continue;
    try {
      if ((await stat(meta.piSessionFile)).size === bytes) return true;
    } catch {
      // 副本不在：交给 reimportState 按「判断不了」处理
    }
  }
  return false;
}

interface CopyEntries {
  meta: SessionMeta;
  /** null = 副本读不了（不在 / 坏了） */
  entries: SessionEntry[] | null;
}

/** 读 orbita 自己的副本。是自家文件，直接 parseSessionEntries，不做版本迁移（导入时已迁好）。 */
async function readCopies(copies: readonly SessionMeta[]): Promise<CopyEntries[]> {
  const out: CopyEntries[] = [];
  for (const meta of copies) {
    if (meta.piSessionFile === null) {
      out.push({ meta, entries: null });
      continue;
    }
    try {
      const entries = parseSessionEntries(await readFile(meta.piSessionFile, "utf8")).filter(
        (entry): entry is SessionEntry => entry.type !== "session",
      );
      out.push({ meta, entries });
    } catch {
      out.push({ meta, entries: null });
    }
  }
  return out;
}

/**
 * 源与一份副本的差异。pi 文件只追加、entry id 随机，导入是原字节复制——两份共有的 entry
 * 就是导入那一刻的内容；**副本里最后一条也在源里的 entry** 就是导入点：
 * 源里导入点之后的 user / assistant 消息 = Proma 的新消息；副本里导入点之后还有 entry =
 * 在 orbita 接着聊过（任何类型都算：压缩、换模型都是在 orbita 跑过轮次才会写）。
 *
 * 导入点之后源里只多了非消息 entry（换模型、改思考档）不算有新消息——边界是聊天记录。
 * Proma 回退重答也照样成立：回退是在树上从旧节点长出新枝，文件照旧只追加，新枝就是新消息。
 *
 * null = 一条共有的 entry 都没有，判断不了。只在源是 v1 格式时发生（迁移时 id 现铸，
 * 每次读出来都不一样；本机 0 条），调用方按「没变」处理。
 */
export function compareToCopy(
  source: readonly SessionEntry[],
  copy: readonly SessionEntry[],
): { newMessages: number; continuedHere: boolean } | null {
  const position = new Map(source.map((entry, index) => [entry.id, index]));
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    const at = position.get(copy[index]?.id ?? "");
    if (at === undefined) continue;
    let newMessages = 0;
    for (const entry of source.slice(at + 1)) {
      if (entry.type !== "message") continue;
      const role = asRecord(entry.message)?.["role"];
      if (role === "user" || role === "assistant") newMessages += 1;
    }
    return { newMessages, continuedHere: index < copy.length - 1 };
  }
  return null;
}

type ReimportState =
  | { kind: "unchanged" }
  | { kind: "updated"; meta: SessionMeta; newMessages: number }
  | { kind: "diverged"; meta: SessionMeta; newMessages: number };

/**
 * 一个已导入的源对照它在 orbita 的全部副本（另导过一份的有两份）：
 * - 有一份已经跟上源（导入点之后源里没有新消息），或有一份判断不了 → 没变
 * - 否则有 orbita 没接着聊的那份 → updated，新消息追加进它（多份时取最近导入的，即新消息最少的）
 * - 都接着聊了 → diverged，另导一份放在新消息最少的那份旁边
 */
export function reimportState(source: readonly SessionEntry[], copies: readonly CopyEntries[]): ReimportState {
  let updated: { meta: SessionMeta; newMessages: number } | null = null;
  let diverged: { meta: SessionMeta; newMessages: number } | null = null;
  for (const copy of copies) {
    const diff = copy.entries === null ? null : compareToCopy(source, copy.entries);
    if (diff === null || diff.newMessages === 0) return { kind: "unchanged" };
    const candidate = { meta: copy.meta, newMessages: diff.newMessages };
    if (!diff.continuedHere) {
      if (updated === null || candidate.newMessages < updated.newMessages) updated = candidate;
    } else if (diverged === null || candidate.newMessages < diverged.newMessages) {
      diverged = candidate;
    }
  }
  if (updated !== null) return { kind: "updated", ...updated };
  if (diverged !== null) return { kind: "diverged", ...diverged };
  return { kind: "unchanged" };
}

/**
 * updated 条目：落点、标题、模型、生命周期全取 orbita 这边的 meta（会话进了 orbita 就归 orbita
 * 管，Proma 侧后来改的标题 / 归档 / 星标不跟）；只有问答时间按新的源重算。
 * folder 为 null：它不进文件夹分组，也没有去向可选。
 */
function updatedPlanItem(
  entry: PromaSessionIndexEntry,
  meta: SessionMeta,
  newMessages: number,
  sessionEntries: readonly SessionEntry[],
  bytes: number,
): ImportPlanItem {
  return {
    sourceId: entry.id,
    source: "proma",
    sourceKind: "pi",
    change: "updated",
    newMessages,
    folder: null,
    sourceFile: entry.piSessionFile,
    sessionId: meta.id,
    parentId: meta.parentId ?? null,
    title: meta.title,
    workspaceId: meta.workspaceId,
    cwd: meta.cwd,
    providerId: meta.providerId,
    modelId: meta.modelId,
    importedModel: meta.importedModel ?? null,
    modelMatched: true,
    archived: meta.archived,
    pinned: meta.pinned,
    starred: meta.starred === true,
    createdAt: meta.createdAt,
    updatedAt: qaTime(lastQaTimestamp(sessionEntries), meta.createdAt, meta.updatedAt),
    bytes,
  };
}

/**
 * 会话的 updatedAt 取**问答时间**：最后一条 user / assistant 消息的时刻（wafo 2026-09-24：
 * 进 orbita 后按会话内部的问答时间排，不按导入时间，也不按 Proma 索引的 updatedAt）。
 *
 * 为什么不信索引：Proma 的归档、置顶这类不发消息的操作也会推高它。本机 423 条可比的根会话
 * 里 53 条比最后一条消息晚 1 小时以上，52 条是成批归档的（时间扎堆在 07-25 22:03、08-17 13:33、
 * 09-05 12:43），导进来会按归档那一刻排。orbita 自己也只在追加消息时推 updatedAt，
 * 置顶、改名都不动它——导入的会话与原生会话由此同一口径。
 *
 * 不早于 createdAt：Proma 的分叉会话带着源会话的旧消息，没发新消息时「最后一条问答」早于
 * 它被创建的时刻；建分叉是用户真做过的事，按创建时刻排。没有任何消息时退回索引值。
 */
function qaTime(lastQa: number | null, createdAt: number | null, fallback: number): number {
  if (lastQa === null) return fallback;
  return createdAt === null ? lastQa : Math.max(lastQa, createdAt);
}

/** pi 文件里最后一条 user / assistant 消息的时刻；一条都没有返回 null。 */
function lastQaTimestamp(entries: readonly SessionEntry[]): number | null {
  let last: number | null = null;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message === null || (message["role"] !== "user" && message["role"] !== "assistant")) continue;
    const timestamp = messageTimestamp(entry, message);
    if (timestamp !== 0 && (last === null || timestamp > last)) last = timestamp;
  }
  return last;
}

/** claude legacy 行里最晚的时间戳（行里只有主对话的 user / assistant）。 */
function lastRowTimestamp(rows: readonly ClaudeMainRow[]): number | null {
  let last: number | null = null;
  for (const row of rows) {
    if (row.timestamp !== 0 && (last === null || row.timestamp > last)) last = row.timestamp;
  }
  return last;
}

/** claude legacy 行里最早的时间戳（索引缺 createdAt 时的兜底；_createdAt 也在 rowTimestamp 里）。 */
function firstTimestamp(rows: readonly ClaudeMainRow[]): number | null {
  for (const row of rows) {
    if (row.timestamp !== 0) return row.timestamp;
  }
  return null;
}

/** pi 文件里最后的思考档（thinking_level_change）；没有 = "medium"（meta 的缺省档）。 */
function lastThinkingLevel(entries: readonly SessionEntry[]): string {
  let level: unknown = "medium";
  for (const entry of entries) {
    if (entry.type === "thinking_level_change") level = entry.thinkingLevel;
  }
  return parseThinkingLevel(level);
}

/** 索引没记模型时从 pi 文件兜：最后的 model_change，再没有就最后一条 assistant 的 model。 */
function modelFromEntries(entries: readonly SessionEntry[]): string | null {
  let fromChange: string | null = null;
  let fromMessage: string | null = null;
  for (const entry of entries) {
    if (entry.type === "model_change") fromChange = entry.modelId;
    if (entry.type === "message") {
      const message = asRecord(entry.message);
      if (message !== null && message["role"] === "assistant") {
        const id = optionalString(message["model"]);
        if (id !== null) fromMessage = id;
      }
    }
  }
  return fromChange ?? fromMessage;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/** 原子复制：copyFile 到随机临时名再 rename（writeTextAtomic 的纪律，大文件不进内存）。 */
async function copyPiFile(source: string, dest: string): Promise<void> {
  const tempPath = `${dest}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await copyFile(source, tempPath);
    await rename(tempPath, dest);
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw cause;
  }
}

/**
 * 执行导入：**先重新扫描再落盘**（不信任调用方手里的旧计划——数据可能变了，
 * 幂等判重也要按当下算；扫描与执行之间数据没变则结果一致）。落盘顺序：先新建
 * 工作区（会话要挂上去），再逐条复制 pi 副本 + 写 meta/transcript。单条失败记进
 * failed 继续——批处理不因一条炸掉，报告里说得清。
 */
/**
 * 执行时的用户选择（ImportRunInput 去掉 sources 的部分；形状在 IPC 边界已校验）。
 * 不传 = 计划全部导入（旧入口与测试的默认）。
 */
export interface ImportSelection {
  /** 勾选的来源（重扫只读这些）；不传 = 只有 Proma */
  sources?: readonly ImportSourceId[];
  /** 勾选的可选条目，按 sourceFile（见 isSelectablePlanItem） */
  sessions: ReadonlySet<string>;
  destinations: readonly ImportDestinationChoice[];
  /** 勾选的 skills；不传 = 不导 skills */
  skills?: SkillSelection;
  /** 勾选的 MCP server 名；不传 = 不导 */
  mcp?: ReadonlySet<string>;
}

/**
 * 按勾选裁计划：留下被勾的可选条目，以及母会话被留下的子会话。勾了但重扫时已不在计划里
 * 的（比如刚被别处导入）自然落空——不报错，报告里本来就数得出实际导入了几条。
 */
export function selectPlan(plan: readonly ImportPlanItem[], chosen: ReadonlySet<string>): ImportPlanItem[] {
  const planSessionIds = new Set(plan.map((item) => item.sessionId));
  const kept = new Set<string>();
  for (const item of plan) {
    if (isSelectablePlanItem(item, planSessionIds) && chosen.has(item.sourceFile)) kept.add(item.sessionId);
  }
  return plan.filter((item) =>
    isSelectablePlanItem(item, planSessionIds) ? kept.has(item.sessionId) : kept.has(item.parentId ?? ""),
  );
}

export async function runImport(deps: RunImporterDeps, selection?: ImportSelection): Promise<ImportRunReport> {
  const { report: scanned, mcpServers } = await scanWithConfigs(deps, selection?.destinations ?? [], selection?.sources ?? ["proma"]);
  const plan = selection === undefined ? scanned.plan : selectPlan(scanned.plan, selection.sessions);
  // 没被勾的会话不落，它们要新建的工作区也不建
  const usedWorkspaceIds = new Set(plan.map((item) => item.workspaceId));
  const report: ImportScanReport = {
    ...scanned,
    plan,
    newWorkspaces: scanned.newWorkspaces.filter((workspace) => usedWorkspaceIds.has(workspace.id)),
    mergedWorkspaceIds: scanned.mergedWorkspaceIds.filter((id) => usedWorkspaceIds.has(id)),
  };
  const failed: ImportRunReport["failed"] = [];
  let imported = 0;
  let updated = 0;
  const runAt = Date.now();
  const ledgerLines: ImportLedgerLine[] = [];

  // 工作区先落。扫描与执行之间用户可能手动加了同路径工作区——回调侧按 path 去重
  // （WorkspaceStore.addImported 语义），挂它的会话依旧成立（按 id 挂）
  const createdWorkspaces: ImportRunReport["createdWorkspaces"] = [];
  for (const workspace of report.newWorkspaces) {
    try {
      await deps.createWorkspace(workspace);
      createdWorkspaces.push(workspace);
    } catch (cause) {
      throw new Error(
        `新建工作区失败（${workspace.name} · ${workspace.path}）：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  // 母会话先落，同批母会话落盘失败的子会话不落：否则 parentId 悬空，子会话从左栏（它不是根）
  // 与右栏（母会话不存在）同时消失。它记进 failed 而不是降为根会话导入——降根之后它就是
  // already-imported，永远挂不回去；不落的话，重导时母会话成功了它按规则 ① / ② 挂回去。
  // 追加（updated）失败的母会话不算：它本来就在 orbita 里，子会话照样挂得上
  const planSessionIds = new Set(report.plan.map((item) => item.sessionId));
  const parentInPlan = (item: ImportPlanItem): boolean =>
    item.parentId !== null && planSessionIds.has(item.parentId);
  const ordered = [
    ...report.plan.filter((item) => !parentInPlan(item)),
    ...report.plan.filter((item) => parentInPlan(item)),
  ];
  const failedSessionIds = new Set<string>();

  for (const item of ordered) {
    if (item.parentId !== null && failedSessionIds.has(item.parentId)) {
      failed.push({
        sourceId: item.sourceId,
        sessionId: null,
        error: "parent session failed to import — import again once it succeeds",
      });
      failedSessionIds.add(item.sessionId);
      continue;
    }
    try {
      if (item.change === "updated") {
        // 追加：副本换成新的源（副本是源的前缀，整份换 = 追加），transcript 整份重派生
        const target = deps.existingMetas.find((meta) => meta.id === item.sessionId)?.piSessionFile ?? null;
        if (target === null) throw new Error("the imported session has no pi session file to update");
        const session = await runPiImport(item, deps, { path: target });
        await deps.refreshSession(item.sessionId, session.records, {
          recentQueries: recentQueriesFromRecords(session.records),
          stats: aggregatePrefixUsage(session.records),
          updatedAt: item.updatedAt,
        });
        updated += 1;
        ledgerLines.push(ledgerLine(item, "update", runAt));
        continue;
      }
      const sessionFile =
        item.sourceKind === "claude-legacy"
          ? await runClaudeLegacyImport(item, deps)
          : item.sourceKind === "claude-code"
            ? await runClaudeCodeImport(item, deps)
            : item.sourceKind === "kimi-code"
              ? await runKimiCodeImport(item, deps)
              : item.sourceKind === "opencode"
                ? await runOpencodeImport(item, deps)
                : item.sourceKind === "reasonix"
                  ? await runReasonixImport(item, deps)
                  : await runPiImport(
              item,
              deps,
              // 另导一份：不能落在原会话副本的文件名上（会盖掉 orbita 接着聊的那份），换一个
              // pi session id（= 新会话的 orbita id）另起文件
              item.change === "diverged"
                ? { path: join(deps.piSessionDir, `${basename(item.sourceFile, ".jsonl").split("_")[0]}_${item.sessionId}.jsonl`), headerId: item.sessionId }
                : { path: join(deps.piSessionDir, basename(item.sourceFile)) },
            );

      // meta + transcript：两条源路最终都汇到同一个形态——records 已由各路返给 meta
      // 构造共用（records 的产出在 runPiImport/runClaudeLegacyImport 里，这里统一落盘）
      const meta: SessionMeta = {
        id: item.sessionId,
        title: item.title,
        // titleSource = user：Proma 的标题分不清是模型起的还是用户改的，当用户名
        // 处理最安全——orbita 的 auto-title 永不覆盖它，名字进仓时什么样就什么样
        titleSource: "user",
        cwd: item.cwd,
        workspaceId: item.workspaceId,
        providerId: item.providerId,
        modelId: item.modelId,
        ...(item.importedModel === null ? null : { importedModel: item.importedModel }),
        importedFrom: item.sourceFile,
        ...(item.parentId === null ? null : { parentId: item.parentId }),
        // mode 落 "plan"（最保守）：Proma 的 permissionMode（bypassPermissions 等）
        // 与 orbita 三档不同构，导入的会话重开时用户自己再调档，不静默继承放权限
        mode: "plan",
        thinkingLevel: sessionFile.thinkingLevel,
        piSessionFile: sessionFile.path,
        pinned: item.pinned,
        // 星标缺席即否（SessionMeta 的纪律）：没星标就不写这个键
        ...(item.starred ? { starred: true } : null),
        archived: item.archived,
        recentQueries: recentQueriesFromRecords(sessionFile.records),
        stats: aggregatePrefixUsage(sessionFile.records),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      await deps.persistSession(meta, sessionFile.records);
      imported += 1;
      ledgerLines.push(ledgerLine(item, item.change === "diverged" ? "copy" : "import", runAt));
    } catch (cause) {
      if (item.change !== "updated") failedSessionIds.add(item.sessionId);
      failed.push({
        sourceId: item.sourceId,
        sessionId: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  await writeLedger(deps, ledgerLines);

  // skills 在会话之后：两者互不依赖，会话是这一页的主体，先落
  const skillResult =
    selection?.skills === undefined
      ? { imported: 0, failed: [] }
      : await importSkills(scanned.skills, selection.skills, deps.skillTarget, new Set(deps.workspaces.map((workspace) => workspace.id)));
  const mcpResult =
    selection?.mcp === undefined ? { imported: 0, failed: [] } : await importMcpServers(mcpServers, selection.mcp, deps.mcpTarget);

  return {
    imported,
    updated,
    skipped: skippedCount(report),
    failed,
    createdWorkspaces,
    mergedWorkspaceIds: report.mergedWorkspaceIds,
    skillsImported: skillResult.imported,
    skillsFailed: skillResult.failed,
    mcpImported: mcpResult.imported,
    mcpFailed: mcpResult.failed,
  };
}

function ledgerLine(item: ImportPlanItem, action: ImportLedgerLine["action"], at: number): ImportLedgerLine {
  return {
    at,
    action,
    source: item.source,
    sourceId: item.sourceId,
    sourceFile: item.sourceFile,
    sessionId: item.sessionId,
    title: item.title,
  };
}

/**
 * 本次导入追加进清单。清单第一次写的时候，把此前导入、清单里还没有的会话补记进去
 * （at 为 null：当时的时刻不可考）——不补的话，它们以后在 orbita 删了会被当成新会话列出。
 *
 * 写失败不让整次导入报错：会话都已落盘，报错会让人以为没导进来。代价只是清单缺这几行
 * （删过的会被当成新的列出），记日志。
 */
async function writeLedger(deps: RunImporterDeps, lines: readonly ImportLedgerLine[]): Promise<void> {
  try {
    const recorded = new Set((await readImportLedger(deps.ledgerFile)).map((line) => line.sessionId));
    const backfill: ImportLedgerLine[] = deps.existingMetas
      .filter((meta) => meta.importedFrom !== undefined && !recorded.has(meta.id))
      .map((meta) => ({
        at: null,
        action: "backfill",
        source: sourceOfImported(deps, meta.importedFrom ?? ""),
        sourceId: null,
        sourceFile: meta.importedFrom ?? "",
        sessionId: meta.id,
        title: meta.title,
      }));
    await appendImportLedger(deps.ledgerFile, [...backfill, ...lines]);
  } catch (cause) {
    console.error("[import] 导入清单写入失败，会话已落盘；在 orbita 删过的会话下次可能被当成新的列出", cause);
  }
}

/** 一条会话的灌入产物：orbita 自己的 pi 本子路径 + 从它派生的 transcript + 思考档。 */
interface ImportedSession {
  path: string;
  records: SessionRecord[];
  thinkingLevel: SessionMeta["thinkingLevel"];
}

/**
 * pi 真源的灌入：v3 原字节复制（保真），v1/v2 用内存迁移后的内容重写。
 * dest.path 由调用方定：新导入落在源文件同名处（文件名含 pi session id，同名即同 session）；
 * 追加落在既有副本上；另导一份换一个 headerId 另起文件（header 改写，entries 原样）。
 */
async function runPiImport(
  item: ImportPlanItem,
  deps: RunImporterDeps,
  dest: { path: string; headerId?: string },
): Promise<ImportedSession> {
  const source = await readPiSource(item.sourceFile, deps.promaRoot, deps.extraSourceRoots ?? []);
  const sessionEntries = source.entries.filter(
    (fileEntry): fileEntry is SessionEntry => fileEntry.type !== "session",
  );
  const destPath = dest.path;
  await mkdir(dirname(destPath), { recursive: true });
  if (source.needsRewrite || dest.headerId !== undefined) {
    const headerId = dest.headerId;
    const lines = source.entries.map((line) =>
      line.type === "session" && headerId !== undefined ? { ...line, id: headerId } : line,
    );
    await writeTextAtomic(destPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  } else {
    await copyPiFile(item.sourceFile, destPath);
  }
  // transcript 里的用户消息还原成用户写的原文（proma-user-text.ts）：主路是 Proma 的界面日志，
  // 读不到就按 Proma 的拼接格式剥。**pi 副本上面已原样落盘**——那是模型当时读到的，不改
  const renderLog = await readRenderLog(deps.promaRoot, item.sourceId);
  const userTexts = promaUserTextMap(sessionEntries, renderLog === null ? null : promaUserTexts(renderLog));
  return {
    path: destPath,
    records: withUserTexts(entriesToRecords(branchEntries(sessionEntries)), userTexts),
    thinkingLevel: parseThinkingLevel(lastThinkingLevel(sessionEntries)),
  };
}

/**
 * Proma 的界面日志（与 claude legacy 源同一个目录、同一种格式）。只用来取用户原文，读不到
 * 不算失败——transcript 退回按格式剥，导入照常。
 */
async function readRenderLog(promaRoot: string, sourceId: string): Promise<string | null> {
  try {
    return await readFile(claudeSourceFile(promaRoot, sourceId), "utf8");
  } catch {
    return null;
  }
}

/**
 * Proma 会话里用户唯一写过的那条（greeting-only.ts 的候选）。当前分支上恰好一条用户消息时才去读
 * 界面日志取原文——绝大多数会话在数用户消息这一步就返回，不多读文件。
 */
async function promaOnlyMessage(entries: readonly SessionEntry[], promaRoot: string, sourceId: string): Promise<string | null> {
  const branch = branchEntries(entries);
  const users = branch.filter((entry) => entry.type === "message" && asRecord(entry.message)?.["role"] === "user");
  if (users.length !== 1) return null;
  const renderLog = await readRenderLog(promaRoot, sourceId);
  return onlyWrittenMessage([...promaUserTextMap(branch, renderLog === null ? null : promaUserTexts(renderLog)).values()]);
}

/**
 * claude legacy 的灌入：从零构造 pi 本子（与 pi 真源的「复制」不同路）。
 * 清洗 → Message 构造 → SessionManager.create + appendMessage 逐条灌入；
 * transcript 从灌出来的 pi entries 派生（与 pi 路同一条派生代码，两侧产物形状对齐）。
 */
async function runClaudeLegacyImport(item: ImportPlanItem, deps: RunImporterDeps): Promise<ImportedSession> {
  const raw = await readFile(item.sourceFile, "utf8");
  const { rows } = parseClaudeRows(raw);
  const { messages } = claudeRowsToMessages(rows, item.providerId);
  await mkdir(deps.piSessionDir, { recursive: true });
  const manager = SessionManager.create(item.cwd, deps.piSessionDir);
  for (const message of messages) {
    manager.appendMessage(message);
  }
  const path = manager.getSessionFile();
  if (path === undefined) {
    // 扫描期已剔除无 assistant 消息的文件；这里防御扫描与执行之间文件被改坏
    throw new Error("no assistant messages — nothing was persisted by pi");
  }
  // 源本身就是界面日志：用户行已是原文，这一步实际只解码 @file: 链接（条数对不上时按格式剥，
  // 对原文是空操作）
  // 与 pi 路同一条派生（branchEntries）：灌出来的是一条直链、没有压缩，两者结果相同，
  // 用同一个入口是为了不让「上下文 vs 全量历史」的分叉再长回来
  const contextEntries = branchEntries(manager.getEntries());
  const userTexts = promaUserTextMap(contextEntries, promaUserTexts(raw));
  return {
    path,
    records: withUserTexts(entriesToRecords(contextEntries), userTexts),
    // claude legacy 没有思考档记录（当时的 Claude Code 无此概念），落缺省档
    thinkingLevel: "medium",
  };
}

/** 补记行的来源：meta 只存了源文件，按它落在哪个来源的根下判断。 */
function sourceOfImported(deps: ImporterDeps, sourceFile: string): ImportSourceId {
  const under = (root: string | undefined): boolean => root !== undefined && sourceFile.startsWith(`${resolve(root)}/`);
  if (under(deps.claudeCode?.projectsDir)) return "claude-code";
  if (under(deps.kimiCode?.sessionsDir)) return "kimi-code";
  if (deps.opencode !== undefined && sourceFile.startsWith(`${resolve(deps.opencode.dbFile)}#`)) return "opencode";
  return "proma";
}

/**
 * Claude Code 会话的灌入：清洗（claude-code.ts）→ 与 claude legacy 同一条 Message 构造 →
 * persistConverted。清洗给出每条用户行在 transcript 里的原文。
 */
async function runClaudeCodeImport(item: ImportPlanItem, deps: RunImporterDeps): Promise<ImportedSession> {
  const session = parseClaudeCodeSession(await readFile(item.sourceFile, "utf8"));
  const { messages, userRowIndexes } = claudeRowsToMessages(session.rows, item.providerId);
  return persistConverted(
    item,
    deps,
    messages,
    userRowIndexes.map((row) => session.displays[row] ?? null),
  );
}

/**
 * Kimi Code 会话的灌入：事件流拼成 Message（kimi-code.ts）→ persistConverted。工具结果里引用的图
 * 从会话自己的 blobs 目录读（与 wire.jsonl 同在 agents/main/ 下，扫描清单里的会话根之内）；
 * 读不到的由转换换成一行文字说明。
 */
async function runKimiCodeImport(item: ImportPlanItem, deps: RunImporterDeps): Promise<ImportedSession> {
  const raw = await readFile(item.sourceFile, "utf8");
  const blobs = new Map<string, string>();
  for (const sha of kimiBlobRefs(raw)) {
    try {
      blobs.set(sha, (await readFile(join(dirname(item.sourceFile), "blobs", sha))).toString("base64"));
    } catch {
      // 缺席即可：转换写文字说明
    }
  }
  const wire = parseKimiWire(raw, item.providerId, blobs);
  return persistConverted(item, deps, wire.messages, wire.userDisplays);
}

/**
 * opencode 会话的灌入：按幂等键拆出库路径与会话 id，只读打开库取这条会话的消息 →
 * opencode.ts 转换 → persistConverted。
 */
async function runOpencodeImport(item: ImportPlanItem, deps: RunImporterDeps): Promise<ImportedSession> {
  const cut = item.sourceFile.lastIndexOf("#");
  if (cut === -1) throw new Error(`not an opencode session key: ${item.sourceFile}`);
  const dbFile = item.sourceFile.slice(0, cut);
  const sessionId = item.sourceFile.slice(cut + 1);
  const parsed = withOpencodeDb(dbFile, (db) => {
    const session = readOpencodeSessions(db).find((candidate) => candidate.id === sessionId);
    if (session === undefined) throw new Error("the session is no longer in opencode's database");
    return opencodeToMessages(readOpencodeMessages(db, sessionId), item.providerId, session.revert);
  });
  return persistConverted(item, deps, parsed.messages, parsed.userDisplays);
}

async function runReasonixImport(item: ImportPlanItem, deps: RunImporterDeps): Promise<ImportedSession> {
  const raw = await readFile(item.sourceFile, "utf8");
  const { rows } = parseReasonixRows(raw);
  // meta 只带来会话级模型（源行上没有）；执行时 meta 被删了就盖 unknown，不拦导入
  const meta = await readReasonixMeta(item.sourceFile);
  const parsed = reasonixToMessages(rows, item.providerId, meta?.model ?? null);
  return persistConverted(item, deps, parsed.messages, parsed.userDisplays);
}

/**
 * 转换类来源的共同落盘：SessionManager.create + appendMessage 逐条灌入。userDisplays 是每条
 * user 消息在 transcript 里的原文（按 messages 里 user 消息的顺序），按 appendMessage 返回的
 * entry id 配上；null（模型读到、用户没写的）的用户记录不进 transcript。pi 副本里它们照留——
 * 续聊时模型看到的上下文与当时一致。
 */
async function persistConverted(
  item: ImportPlanItem,
  deps: RunImporterDeps,
  messages: readonly Message[],
  userDisplays: readonly (string | null)[],
): Promise<ImportedSession> {
  await mkdir(deps.piSessionDir, { recursive: true });
  const manager = SessionManager.create(item.cwd, deps.piSessionDir);
  const texts = new Map<string, string>();
  const hidden = new Set<string>();
  let userIndex = 0;
  for (const message of messages) {
    const id = manager.appendMessage(message);
    if (message.role !== "user") continue;
    const display = userDisplays[userIndex] ?? null;
    userIndex += 1;
    if (display === null) hidden.add(id);
    else texts.set(id, display);
  }
  const path = manager.getSessionFile();
  if (path === undefined) {
    // 扫描期已剔除转不出 assistant 消息的文件；这里防御扫描与执行之间文件被改
    throw new Error("no assistant messages — nothing was persisted by pi");
  }
  const records = entriesToRecords(branchEntries(manager.getEntries())).filter(
    (record) => record.role !== "user" || !hidden.has(record.id),
  );
  return {
    path,
    records: withUserTexts(records, texts),
    // 源的思考档位（Claude Code 的 effort、Kimi 的 thinkingEffort）与 orbita 的档位不同构，落缺省档
    thinkingLevel: "medium",
  };
}

function skippedCount(report: ImportScanReport): number {
  return report.skipped.length;
}
