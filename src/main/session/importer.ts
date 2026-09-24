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
 * （`parseSessionEntries` / `migrateSessionEntries` / `buildContextEntries`），
 * 版本迁移在内存里做完、写到 orbita 自己的副本上，源文件一个字节都不动。
 *
 * ## 幂等
 *
 * 幂等键 = 源 pi 文件绝对路径，存在新会话 meta 的 `importedFrom` 里（契约层 commit
 * 讲了为什么不另立 state 文件）。执行前重新扫描，`already-imported` 与本次扫描内
 * 的同源重复都按跳过处理。解析外部 JSONL 一律坏行跳过（pi 的 `parseSessionEntries`
 * 就是这么做的），一条坏行不炸整批。
 */
import { copyFile, mkdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildContextEntries,
  parseSessionEntries,
  migrateSessionEntries,
  SessionManager,
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
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
import { aggregatePrefixUsage } from "./store.ts";
import {
  deriveSessionTitle,
  recentQueriesFromRecords,
  type SessionMeta,
  type SessionRecord,
} from "../../shared/session.ts";
import type {
  ImportPlanItem,
  ImportRunReport,
  ImportScanReport,
  ImportSkipItem,
  ImportSkipReason,
  ImportWorkspacePlan,
} from "../../shared/import.ts";

/** 引擎对外的全部环境依赖。生产由 main 装配，测试注入临时目录与可预测的 id。 */
export interface ImporterDeps {
  /** Proma 数据根（~/.proma-dev）。**只读** */
  promaRoot: string;
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
      // 字段两代：早期 pinned，后来 starred（互斥出现），语义都是「置顶」
      pinned: item["pinned"] === true || item["starred"] === true,
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
 * pi 的压缩感知 entry 列表 → orbita 的 SessionRecord[]。
 *
 * - message：user / assistant / toolResult 翻译成 TranscriptItem；**空 error 回答不进**
 *   （isEmptyErrorAssistantEntry——与落盘侧、分支对账侧同一个谓词，三处共享）。
 * - compaction → CompactedRecord 界碑（tokensAfter pi 不给，缺省——展示时回退）。
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
      create: null,
      mergedInto: null,
    };
  }

  // 规则 ①：同址合并（realpath 相等）
  const wanted = await normalizeForMatch(promaWorkspace.projectRootPath);
  for (const orbita of orbitaWorkspaces) {
    if ((await normalizeForMatch(orbita.path)) === wanted) {
      return { workspaceId: orbita.id, cwd: orbita.path, create: null, mergedInto: orbita.id };
    }
  }

  // 同名不同址（或全新路径）：新建。名字沿用 Proma 的，走 orbita 的落盘规则
  // （空白退路径末段、40 字符上限）；id 只铸一次，create.id 就是挂上去的 workspaceId
  const id = deps.newId();
  return {
    workspaceId: id,
    cwd: promaWorkspace.projectRootPath,
    create: {
      id,
      name: normalizeWorkspaceName(promaWorkspace.name, promaWorkspace.projectRootPath),
      path: promaWorkspace.projectRootPath,
      merged: false,
    },
    mergedInto: null,
  };
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

export async function scanImport(deps: ImporterDeps): Promise<ImportScanReport> {
  const skipped: ImportSkipItem[] = [];
  const skip = (sourceId: string, title: string | null, reason: ImportSkipReason, detail?: string): void => {
    skipped.push(detail === undefined ? { sourceId, title, reason } : { sourceId, title, reason, detail });
  };

  const plan: ImportPlanItem[] = [];
  const newWorkspaceByKey = new Map<string, ImportWorkspacePlan>();
  const mergedIds = new Set<string>();
  let modelFallbackCount = 0;
  let totalBytes = 0;

  // 幂等底：已导入过的源路径（meta.importedFrom）+ 本次扫描内的同源去重
  const importedSources = new Set<string>();
  for (const meta of deps.existingMetas) {
    if (meta.importedFrom !== undefined) importedSources.add(meta.importedFrom);
  }
  const seenSources = new Set<string>();

  let promaSessions: ReturnType<typeof parsePromaSessions>;
  try {
    promaSessions = parsePromaSessions(await readFile(join(deps.promaRoot, "agent-sessions.json"), "utf8"));
  } catch (cause) {
    throw new Error(
      `读不了 Proma 会话索引（${join(deps.promaRoot, "agent-sessions.json")}）：${cause instanceof Error ? cause.message : String(cause)}`,
    );
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
  try {
    promaWorkspaces = parsePromaWorkspaces(await readFile(join(deps.promaRoot, "agent-workspaces.json"), "utf8"));
  } catch {
    // 工作区表读不到 ≠ 导不了：全部按无归属走规则 ②（TASKS）。旧版 Proma 可能
    // 没有这份文件，会话照导，只是没有工作区归属
  }

  for (const entry of promaSessions.entries) {
    if (importedSources.has(entry.piSessionFile)) {
      skip(entry.id, entry.title || null, "already-imported");
      continue;
    }
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
    let bytes: number;
    try {
      bytes = (await stat(entry.piSessionFile)).size;
    } catch {
      skip(entry.id, entry.title || null, "missing-file", entry.piSessionFile);
      continue;
    }

    let source: PiSource;
    try {
      source = await readPiSource(entry.piSessionFile, deps.promaRoot, deps.extraSourceRoots ?? []);
    } catch (cause) {
      skip(entry.id, entry.title || null, "bad-session-file", cause instanceof Error ? cause.message : String(cause));
      continue;
    }
    const sessionEntries = source.entries.filter(
      (fileEntry): fileEntry is SessionEntry => fileEntry.type !== "session",
    );

    const resolution = await resolveWorkspaceTarget(
      entry.workspaceId,
      promaWorkspaces,
      deps.workspaces,
      source.headerCwd,
      deps,
    );
    if (resolution.create !== null) {
      // 同一个 Proma 工作区的多条会话共享一次新建（path 为键），id 对齐到第一份计划
      const existing = newWorkspaceByKey.get(resolution.create.path);
      if (existing === undefined) {
        newWorkspaceByKey.set(resolution.create.path, resolution.create);
      } else {
        resolution.workspaceId = existing.id;
      }
    }
    if (resolution.mergedInto !== null) mergedIds.add(resolution.mergedInto);

    // 模型：索引的 modelId 优先，缺失时从 pi 文件补（最后的 model_change / assistant model）
    const promaModelId = entry.modelId ?? modelFromEntries(sessionEntries);
    const mapped = mapModel(promaModelId, deps.registeredModels, deps.fallbackModel);
    if (!mapped.matched) modelFallbackCount += 1;

    totalBytes += bytes;
    plan.push({
      sourceId: entry.id,
      sourceKind: "pi",
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
      createdAt: entry.createdAt ?? (source.headerTimestamp || Date.now()),
      updatedAt: entry.updatedAt ?? entry.createdAt ?? (source.headerTimestamp || Date.now()),
      bytes,
    });
  }

  // —— claude legacy 条目：渲染 JSONL 转换导入（源文件按 <promaRoot>/agent-sessions/<id>.jsonl 推导） ——
  for (const entry of promaSessions.claudeEntries) {
    const sourceFile = claudeSourceFile(deps.promaRoot, entry.id);
    if (importedSources.has(sourceFile)) {
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
    const resolution = await resolveWorkspaceTarget(
      entry.workspaceId,
      promaWorkspaces,
      deps.workspaces,
      "",
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
      sourceKind: "claude-legacy",
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
      createdAt,
      updatedAt: entry.updatedAt ?? entry.createdAt ?? createdAt,
      bytes,
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

  return {
    plan,
    newWorkspaces: [...newWorkspaceByKey.values()].filter((workspace) => referenced.has(workspace.id)),
    mergedWorkspaceIds: [...mergedIds].filter((id) => referenced.has(id)),
    skipped,
    withoutPiSession: promaSessions.withoutPiFile,
    totalBytes,
    modelFallbackCount,
    subSessionCount,
    orphanedSubSessions,
  };
}

/** claude legacy 条目的源文件路径（索引里没有，按 Proma 的目录惯例推导）。 */
function claudeSourceFile(promaRoot: string, id: string): string {
  return join(promaRoot, "agent-sessions", `${id}.jsonl`);
}

// ---------------------------------------------------------------------------
// 子会话挂回母会话
// ---------------------------------------------------------------------------

/** 母会话在 orbita 这边的坐标：子会话按它挂 parentId、对齐工作区与 cwd。 */
interface ParentTarget {
  sessionId: string;
  workspaceId: string | null;
  cwd: string;
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
 * 本来就同工作区，对齐是防御），pinned / archived 置 false——子会话没有生命周期，
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
      return { sessionId: inPlan.sessionId, workspaceId: inPlan.workspaceId, cwd: inPlan.cwd };
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
    if (!parentSourceById.has(item.sourceId)) continue;
    const rootSourceId = rootAncestor(item.sourceId);
    const target = rootSourceId === null ? null : findParent(rootSourceId);
    if (target === null) {
      orphanedSubSessions += 1;
      continue;
    }
    item.parentId = target.sessionId;
    item.workspaceId = target.workspaceId;
    item.cwd = target.cwd;
    item.pinned = false;
    item.archived = false;
    subSessionCount += 1;
  }
  return { subSessionCount, orphanedSubSessions };
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
export async function runImport(deps: RunImporterDeps): Promise<ImportRunReport> {
  const report = await scanImport(deps);
  const failed: ImportRunReport["failed"] = [];
  let imported = 0;

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
  // already-imported，永远挂不回去；不落的话，重导时母会话成功了它按规则 ① / ② 挂回去
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
      const sessionFile =
        item.sourceKind === "pi" ? await runPiImport(item, deps) : await runClaudeLegacyImport(item, deps);

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
        archived: item.archived,
        recentQueries: recentQueriesFromRecords(sessionFile.records),
        stats: aggregatePrefixUsage(sessionFile.records),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      await deps.persistSession(meta, sessionFile.records);
      imported += 1;
    } catch (cause) {
      failedSessionIds.add(item.sessionId);
      failed.push({
        sourceId: item.sourceId,
        sessionId: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return {
    imported,
    skipped: skippedCount(report),
    failed,
    createdWorkspaces,
    mergedWorkspaceIds: report.mergedWorkspaceIds,
  };
}

/** 一条会话的灌入产物：orbita 自己的 pi 本子路径 + 从它派生的 transcript + 思考档。 */
interface ImportedSession {
  path: string;
  records: SessionRecord[];
  thinkingLevel: SessionMeta["thinkingLevel"];
}

/**
 * pi 真源的灌入：v3 原字节复制（保真），v1/v2 用内存迁移后的内容重写。
 * 同名副本已存在（极端：两个 Proma 索引共用同一 pi 文件，扫描已按同源去重，
 * 这里只是防御）直接复用——文件名含 pi session id，同名即同 session。
 */
async function runPiImport(item: ImportPlanItem, deps: RunImporterDeps): Promise<ImportedSession> {
  const source = await readPiSource(item.sourceFile, deps.promaRoot, deps.extraSourceRoots ?? []);
  const sessionEntries = source.entries.filter(
    (fileEntry): fileEntry is SessionEntry => fileEntry.type !== "session",
  );
  const destPath = join(deps.piSessionDir, basename(item.sourceFile));
  await mkdir(deps.piSessionDir, { recursive: true });
  if (source.needsRewrite) {
    await writeTextAtomic(destPath, `${source.entries.map((line) => JSON.stringify(line)).join("\n")}\n`);
  } else {
    await copyPiFile(item.sourceFile, destPath);
  }
  return {
    path: destPath,
    records: entriesToRecords(buildContextEntries(sessionEntries)),
    thinkingLevel: parseThinkingLevel(lastThinkingLevel(sessionEntries)),
  };
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
  return {
    path,
    records: entriesToRecords(manager.buildContextEntries()),
    // claude legacy 没有思考档记录（当时的 Claude Code 无此概念），落缺省档
    thinkingLevel: "medium",
  };
}

function skippedCount(report: ImportScanReport): number {
  return report.skipped.length;
}
