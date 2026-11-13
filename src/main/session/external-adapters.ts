/**
 * 外部来源的 adapter：每个来源怎么列它的会话、怎么只读头部取标题、怎么只读全文投影成记录。
 * 解析复用各来源现成的解析器（claude-code.ts、codex.ts、kimi-code.ts、opencode.ts、reasonix.ts、
 * zcode.ts、proma-index.ts + pi-book.ts）——它们原本服务导入，产出就是「Message[] + 每条用户
 * 消息的原文」，这里只丢掉落盘那一半：不复制、不写 Orbita 的会话库、不写源目录。
 *
 * 三段的成本纪律（read_task 每次不带参数都会列一次目录）：
 * - candidates：只 readdir + stat（库来源是一次只取会话表的查询），不读会话内容。
 * - facts：只对入选的那几条读头部（TITLE_HEAD_BYTES）或侧车元数据。
 * - load：读全文，受字节预算约束（EXTERNAL_*_MAX_BYTES），超了如实报错。
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExternalSourceId } from "../../shared/external-sources.ts";
import { UNASSIGNED_PROVIDER_ID, type SessionRecord } from "../../shared/session.ts";
import { isNotFound } from "../fs-errors.ts";
import { isInside } from "../path-boundary.ts";
import { claudeRowsToMessages, parseClaudeRows } from "./claude-legacy.ts";
import { parseClaudeCodeSession, parseClaudeDesktopSession, type ClaudeDesktopSession } from "./claude-code.ts";
import { parseCodexRollout } from "./codex.ts";
import { kimiBlobRefs, parseKimiSessionState, parseKimiWire, readKimiWorkspaces } from "./kimi-code.ts";
import { opencodeSessionBytes, opencodeToMessages, readOpencodeMessages, readOpencodeSessions } from "./opencode.ts";
import { branchEntries, entriesToRecords, messagesToRecords, parsePiBook } from "./pi-book.ts";
import { parsePromaSessions, parsePromaWorkspaces } from "./proma-index.ts";
import { promaUserDisplays, promaUserTextMap, promaUserTexts, withUserTexts } from "./proma-user-text.ts";
import { isReasonixConversationFile, parseReasonixRows, readReasonixMeta, reasonixToMessages } from "./reasonix.ts";
import { withReadOnlyDb } from "./sqlite-readonly.ts";
import { readZcodeMessages, readZcodeSessions, zcodeSessionBytes } from "./zcode.ts";

// ---------------------------------------------------------------------------
// 字节预算（2026-11 a94818e85 定的口径，扩到全部来源）
// ---------------------------------------------------------------------------

/** 一条会话的源文件（JSONL）或它在库里的消息总量 */
export const EXTERNAL_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
/** Kimi 工具结果里引用的单张图 */
export const EXTERNAL_BLOB_MAX_BYTES = 8 * 1024 * 1024;
/** Kimi 一条会话引用的图合计 */
export const EXTERNAL_BLOBS_MAX_BYTES = 24 * 1024 * 1024;
/** 一条会话读进内存的总量（源文件 + 图 / Proma 界面日志） */
export const EXTERNAL_TOTAL_MAX_BYTES = 48 * 1024 * 1024;
const BOUNDED_READ_CHUNK_BYTES = 64 * 1024;
/** 列目录时为取标题只读的头部 */
const TITLE_HEAD_BYTES = 256 * 1024;

export class ExternalSessionSizeError extends Error {
  readonly code = "ERR_EXTERNAL_SESSION_SIZE";

  constructor(resource: string, size: number, limit: number) {
    super(`${resource} exceeds the ${limit} byte read limit (it is ${size} bytes)`);
    this.name = "ExternalSessionSizeError";
  }
}

/** 边读边数：stat 之后文件还在长（源应用正写着）也不会读超。 */
async function readBoundedFile(path: string, limit: number, resource: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const initial = await handle.stat();
    if (initial.size > limit) throw new ExternalSessionSizeError(resource, initial.size, limit);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = limit + 1 - total;
      if (remaining <= 0) throw new ExternalSessionSizeError(resource, total + 1, limit);
      const buffer = Buffer.alloc(Math.min(BOUNDED_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new ExternalSessionSizeError(resource, total, limit);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 只读文件开头一段（取标题、cwd）；最后一行多半是半截，各解析器都按坏行跳过。 */
async function readHead(path: string, bytes = TITLE_HEAD_BYTES): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(Math.min(bytes, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBoundedText(path: string, resource: string): Promise<string> {
  return (await readBoundedFile(path, EXTERNAL_SOURCE_MAX_BYTES, resource)).toString("utf8");
}

// ---------------------------------------------------------------------------
// adapter 的形状
// ---------------------------------------------------------------------------

/** 列目录得到的一条会话：只有 stat 得到的东西（库来源多带会话表里的几列）。 */
export interface ExternalCandidate {
  source: ExternalSourceId;
  /** 从哪个数据目录列出来的 */
  root: string;
  /** ref 的哈希原料：源文件的绝对路径；库来源是「库路径#会话 id」 */
  key: string;
  /** 报错时告诉用户是哪个文件（库来源是库文件） */
  file: string;
  /** 来源自己的会话 id（标题兜底用前 8 位） */
  sourceId: string;
  /** 排序用的「最近更新」：文件 mtime；库来源是会话表的 time_updated */
  mtime: number;
  /** 列目录时顺手拿到的（库、索引、桌面清单）；facts 只补缺的 */
  known: Partial<ExternalSessionFacts>;
  /** Proma：这条是 pi 本子还是 Claude 时代的界面日志 */
  promaKind?: "pi" | "claude-legacy";
  /** Kimi：会话所属的工作区 id（cwd 兜底） */
  workspaceId?: string;
}

export interface ExternalSessionFacts {
  title: string | null;
  cwd: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ExternalLoaded extends ExternalSessionFacts {
  records: SessionRecord[];
}

export interface ExternalAdapterContext {
  /** 这个来源全部的数据目录（Proma 的索引路径越界检查要用） */
  roots: readonly string[];
  /** Claude 桌面应用的会话清单目录（只读；不存在照常） */
  claudeDesktopDir: string;
}

export interface ExternalAdapter {
  /** 数据目录在不在的判据：会话入口文件 / 目录的相对路径与类型 */
  entry: { path: readonly string[]; type: "file" | "dir" };
  candidates(root: string, context: ExternalAdapterContext): Promise<ExternalCandidate[]>;
  facts(candidate: ExternalCandidate, context: ExternalAdapterContext): Promise<ExternalSessionFacts>;
  load(candidate: ExternalCandidate, context: ExternalAdapterContext): Promise<ExternalLoaded>;
  /** 数据目录里认得出、但读不了的部分（如实列进目录，不静默漏掉） */
  notes?(root: string): Promise<string[]>;
}

const NO_FACTS: ExternalSessionFacts = { title: null, cwd: null, createdAt: null, updatedAt: null };

function withKnown(candidate: ExternalCandidate, found: Partial<ExternalSessionFacts>): ExternalSessionFacts {
  return {
    title: candidate.known.title ?? found.title ?? null,
    cwd: candidate.known.cwd ?? found.cwd ?? null,
    createdAt: candidate.known.createdAt ?? found.createdAt ?? null,
    updatedAt: candidate.known.updatedAt ?? found.updatedAt ?? null,
  };
}

async function directoryEntries(path: string): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.mtimeMs : null;
  } catch {
    // 列目录与源应用写入并发时，单条消失不挡其余会话
    return null;
  }
}

/** 一批文件并行 stat，消失的丢掉。 */
async function statAll<T extends { file: string }>(items: readonly T[]): Promise<(T & { mtime: number })[]> {
  const stats = await Promise.all(items.map((item) => mtimeOf(item.file)));
  return items.flatMap((item, index) => {
    const mtime = stats[index];
    return mtime === null || mtime === undefined ? [] : [{ ...item, mtime }];
  });
}

function minPositive(values: readonly (number | null | undefined)[]): number | null {
  const valid = values.filter((value): value is number => typeof value === "number" && value > 0);
  return valid.length === 0 ? null : Math.min(...valid);
}

// ---------------------------------------------------------------------------
// Claude Code：<root>/projects/<编码后的 cwd>/<会话 id>.jsonl
// ---------------------------------------------------------------------------

/** 桌面应用的会话清单：<目录>/<账户>/<组织>/local_*.json。目录不在、单条坏了都跳过。 */
async function readClaudeDesktopSessions(dir: string): Promise<ClaudeDesktopSession[]> {
  const subdirs = async (path: string): Promise<string[]> =>
    (await directoryEntries(path).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  const out: ClaudeDesktopSession[] = [];
  for (const account of await subdirs(dir)) {
    for (const org of await subdirs(account)) {
      for (const entry of await directoryEntries(org).catch(() => [])) {
        if (!entry.isFile() || !entry.name.startsWith("local_") || !entry.name.endsWith(".json")) continue;
        try {
          const parsed = parseClaudeDesktopSession(await readFile(join(org, entry.name), "utf8"));
          if (parsed !== null) out.push(parsed);
        } catch {
          // 读不了的一条：它指向的文件按命令行会话处理
        }
      }
    }
  }
  return out;
}

const claudeCode: ExternalAdapter = {
  entry: { path: ["projects"], type: "dir" },
  async candidates(root, context) {
    const projectsDir = join(root, "projects");
    const files: { file: string; sourceId: string }[] = [];
    for (const project of await directoryEntries(projectsDir)) {
      if (!project.isDirectory()) continue;
      // 子代理文件在更深一层（<会话>/subagents/），不列
      for (const entry of await directoryEntries(join(projectsDir, project.name)).catch(() => [])) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push({ file: join(projectsDir, project.name, entry.name), sourceId: entry.name.slice(0, -".jsonl".length) });
        }
      }
    }
    // 桌面应用每次续接旧会话都另起一个文件、把历史整段复制过去：被续接取代的旧文件不列
    const desktop = await readClaudeDesktopSessions(context.claudeDesktopDir);
    const superseded = new Set(desktop.flatMap((entry) => entry.priorCliSessionIds));
    const listed = new Map(desktop.map((entry) => [entry.cliSessionId, entry]));
    return (await statAll(files.filter((item) => !superseded.has(item.sourceId)))).map((item) => {
      const entry = listed.get(item.sourceId);
      return {
        source: "claude-code" as const,
        root,
        key: resolve(item.file),
        file: item.file,
        sourceId: item.sourceId,
        mtime: item.mtime,
        known: entry === undefined ? {} : { title: entry.title, cwd: entry.folder, createdAt: entry.createdAt },
      };
    });
  },
  async facts(candidate) {
    const session = parseClaudeCodeSession(await readHead(candidate.file));
    return withKnown(candidate, {
      title: session.title ?? session.firstPrompt,
      cwd: session.cwd,
      createdAt: minPositive(session.rows.map((row) => row.timestamp)),
    });
  },
  async load(candidate) {
    const session = parseClaudeCodeSession(await readBoundedText(candidate.file, "the session file"));
    const { messages, userRowIndexes } = claudeRowsToMessages(session.rows, UNASSIGNED_PROVIDER_ID);
    const times = session.rows.map((row) => row.timestamp).filter((time) => time > 0);
    return {
      ...withKnown(candidate, {
        title: session.title ?? session.firstPrompt,
        cwd: session.cwd,
        createdAt: minPositive(times),
        updatedAt: times.length === 0 ? null : Math.max(...times),
      }),
      records: messagesToRecords(
        messages,
        userRowIndexes.map((row) => session.displays[row] ?? null),
      ),
    };
  },
};

// ---------------------------------------------------------------------------
// Codex：<root>/sessions/YYYY/MM/DD/rollout-*.jsonl
// ---------------------------------------------------------------------------

const codex: ExternalAdapter = {
  entry: { path: ["sessions"], type: "dir" },
  async candidates(root) {
    const sessionsDir = join(root, "sessions");
    const files: { file: string; sourceId: string }[] = [];
    const dirsIn = async (path: string): Promise<string[]> =>
      (await directoryEntries(path).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const year of await dirsIn(sessionsDir)) {
      for (const month of await dirsIn(join(sessionsDir, year))) {
        for (const day of await dirsIn(join(sessionsDir, year, month))) {
          const dir = join(sessionsDir, year, month, day);
          for (const entry of await directoryEntries(dir).catch(() => [])) {
            if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
              files.push({ file: join(dir, entry.name), sourceId: entry.name.slice(0, -".jsonl".length) });
            }
          }
        }
      }
    }
    return (await statAll(files)).map((item) => ({
      source: "codex" as const,
      root,
      key: resolve(item.file),
      file: item.file,
      // 文件名是 rollout-<时间>-<uuid>：标题兜底取 uuid 段
      sourceId: item.sourceId.slice(-36),
      mtime: item.mtime,
      known: {},
    }));
  },
  async facts(candidate) {
    const rollout = parseCodexRollout(await readHead(candidate.file), UNASSIGNED_PROVIDER_ID);
    return withKnown(candidate, {
      title: rollout.firstPrompt,
      cwd: rollout.meta.cwd,
      createdAt: rollout.meta.timestamp > 0 ? rollout.meta.timestamp : null,
    });
  },
  async load(candidate) {
    const rollout = parseCodexRollout(await readBoundedText(candidate.file, "the rollout file"), UNASSIGNED_PROVIDER_ID);
    return {
      ...withKnown(candidate, {
        title: rollout.firstPrompt,
        cwd: rollout.meta.cwd,
        createdAt: rollout.meta.timestamp > 0 ? rollout.meta.timestamp : null,
        updatedAt: rollout.lastTimestamp > 0 ? rollout.lastTimestamp : null,
      }),
      records: messagesToRecords(rollout.messages, rollout.userDisplays),
    };
  },
};

// ---------------------------------------------------------------------------
// Kimi Code / Kimi Work：<root>/sessions/<工作区>/<会话>/{state.json, agents/main/wire.jsonl}
// ---------------------------------------------------------------------------

function kimiWire(candidate: ExternalCandidate): string {
  return candidate.file;
}

function kimiSessionDir(candidate: ExternalCandidate): string {
  return resolve(candidate.file, "..", "..", "..");
}

async function readKimiState(candidate: ExternalCandidate) {
  try {
    return parseKimiSessionState(await readFile(join(kimiSessionDir(candidate), "state.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Kimi Work 在用户原文前塞 `<meta …/>` 给模型，有时还写进自动标题；两处都不是标题正文。 */
function kimiTitle(source: ExternalSourceId, raw: string | null): string | null {
  if (raw === null) return null;
  return source === "kimi-work" ? raw.replace(/^(?:\s*<meta\b[^>]*\/>\s*)+/, "") : raw;
}

async function kimiFacts(candidate: ExternalCandidate): Promise<ExternalSessionFacts> {
  const state = await readKimiState(candidate);
  const workspaces = await readKimiWorkspaces(join(candidate.root, "workspaces.json"));
  let title = state?.title ?? null;
  if (title === null) {
    // 没标题时只读头部找首条提问；读不到完整会话也不影响目录
    try {
      title = parseKimiWire(await readHead(kimiWire(candidate)), UNASSIGNED_PROVIDER_ID, new Map()).firstPrompt;
    } catch {
      title = null;
    }
  }
  return {
    title: kimiTitle(candidate.source, title),
    cwd: state?.cwd ?? (candidate.workspaceId === undefined ? null : (workspaces.roots.get(candidate.workspaceId) ?? null)),
    createdAt: state?.createdAt ?? null,
    updatedAt: state?.updatedAt ?? null,
  };
}

function kimiAdapter(source: "kimi-code" | "kimi-work"): ExternalAdapter {
  return {
    entry: { path: ["sessions"], type: "dir" },
    async candidates(root) {
      const sessionsDir = join(root, "sessions");
      const workspaces = await readKimiWorkspaces(join(root, "workspaces.json"));
      const files: { file: string; sourceId: string; workspaceId: string }[] = [];
      for (const workspace of await directoryEntries(sessionsDir)) {
        if (!workspace.isDirectory() || workspace.name.startsWith(".") || workspaces.deleted.has(workspace.name)) continue;
        for (const session of await directoryEntries(join(sessionsDir, workspace.name)).catch(() => [])) {
          if (!session.isDirectory() || session.name.startsWith(".")) continue;
          // Kimi Work 的 ctitle-* 是自动起标题的内部任务，不是源应用里给用户看的会话
          if (source === "kimi-work" && session.name.startsWith("ctitle-")) continue;
          files.push({
            file: join(sessionsDir, workspace.name, session.name, "agents", "main", "wire.jsonl"),
            sourceId: session.name,
            workspaceId: workspace.name,
          });
        }
      }
      return (await statAll(files)).map((item) => ({
        source,
        root,
        key: resolve(item.file),
        file: item.file,
        sourceId: item.sourceId,
        workspaceId: item.workspaceId,
        mtime: item.mtime,
        known: {},
      }));
    },
    facts: kimiFacts,
    async load(candidate) {
      const wireBuffer = await readBoundedFile(kimiWire(candidate), EXTERNAL_SOURCE_MAX_BYTES, "wire.jsonl");
      const raw = wireBuffer.toString("utf8");
      const blobDir = join(kimiSessionDir(candidate), "agents", "main", "blobs");
      const blobFiles: { sha: string; path: string }[] = [];
      let planned = 0;
      for (const sha of kimiBlobRefs(raw)) {
        const path = join(blobDir, sha);
        let size: number;
        try {
          const info = await stat(path);
          if (!info.isFile()) continue;
          size = info.size;
        } catch {
          // 图片缺席时由解析器换成文字说明
          continue;
        }
        if (size > EXTERNAL_BLOB_MAX_BYTES) throw new ExternalSessionSizeError("an image blob", size, EXTERNAL_BLOB_MAX_BYTES);
        planned += size;
        if (planned > EXTERNAL_BLOBS_MAX_BYTES) {
          throw new ExternalSessionSizeError("the referenced image blobs", planned, EXTERNAL_BLOBS_MAX_BYTES);
        }
        if (wireBuffer.byteLength + planned > EXTERNAL_TOTAL_MAX_BYTES) {
          throw new ExternalSessionSizeError("the session with its images", wireBuffer.byteLength + planned, EXTERNAL_TOTAL_MAX_BYTES);
        }
        blobFiles.push({ sha, path });
      }
      const blobs = new Map<string, string>();
      let actual = 0;
      for (const blob of blobFiles) {
        try {
          const data = await readBoundedFile(blob.path, EXTERNAL_BLOB_MAX_BYTES, "an image blob");
          actual += data.byteLength;
          if (actual > EXTERNAL_BLOBS_MAX_BYTES) {
            throw new ExternalSessionSizeError("the referenced image blobs", actual, EXTERNAL_BLOBS_MAX_BYTES);
          }
          if (wireBuffer.byteLength + actual > EXTERNAL_TOTAL_MAX_BYTES) {
            throw new ExternalSessionSizeError("the session with its images", wireBuffer.byteLength + actual, EXTERNAL_TOTAL_MAX_BYTES);
          }
          blobs.set(blob.sha, data.toString("base64"));
        } catch (error) {
          if (error instanceof ExternalSessionSizeError) throw error;
          // 图片在检查后消失或不可读：由解析器换成文字说明
        }
      }
      const wire = parseKimiWire(raw, UNASSIGNED_PROVIDER_ID, blobs);
      const facts = await kimiFacts(candidate);
      return {
        title: facts.title ?? kimiTitle(source, wire.firstPrompt),
        cwd: facts.cwd,
        createdAt: facts.createdAt ?? wire.firstAt,
        updatedAt: facts.updatedAt ?? wire.lastAt,
        records: messagesToRecords(wire.messages, wire.userDisplays),
      };
    },
  };
}

/** Kimi Work 当前桌面运行时在其 appData 下的 kimi-code 数据根。 */
export function kimiWorkDataRoot(appData: string): string {
  return join(appData, "kimi-desktop", "daimon-share", "daimon", "runtime", "kimi-code", "home");
}

// ---------------------------------------------------------------------------
// OpenCode / ZCode：SQLite 会话库（session / message / part），只读打开（sqlite-readonly.ts）
// ---------------------------------------------------------------------------

interface DbSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

function dbAdapter(options: {
  source: "opencode" | "zcode";
  dbPath: readonly string[];
  sessions(db: DatabaseSync): (DbSessionRow & { revert?: string | null })[];
  messages: typeof readOpencodeMessages;
  bytes: typeof opencodeSessionBytes;
}): ExternalAdapter {
  const sessionIdOf = (candidate: ExternalCandidate): string => candidate.key.slice(candidate.key.lastIndexOf("#") + 1);
  /** 读一条会话的消息：先看体量，超预算不读 */
  const readSession = (candidate: ExternalCandidate) =>
    withReadOnlyDb(candidate.file, (db) => {
      const id = sessionIdOf(candidate);
      const session = options.sessions(db).find((row) => row.id === id);
      if (session === undefined) return null;
      const size = options.bytes(db, id);
      if (size > EXTERNAL_SOURCE_MAX_BYTES) throw new ExternalSessionSizeError("the session's messages", size, EXTERNAL_SOURCE_MAX_BYTES);
      // ZCode 的撤回在取数层按它自己的可见规则取分支（zcode.ts），转换时 revert 传 null
      return opencodeToMessages(options.messages(db, id), UNASSIGNED_PROVIDER_ID, session.revert ?? null);
    });
  return {
    entry: { path: options.dbPath, type: "file" },
    async candidates(root) {
      const dbFile = join(root, ...options.dbPath);
      try {
        await stat(dbFile);
      } catch (cause) {
        if (isNotFound(cause)) return [];
        throw cause;
      }
      const rows = await withReadOnlyDb(dbFile, options.sessions);
      return rows.map((row) => ({
        source: options.source,
        root,
        key: `${resolve(dbFile)}#${row.id}`,
        file: dbFile,
        sourceId: row.id,
        mtime: row.updatedAt || row.createdAt,
        known: {
          title: row.title,
          cwd: row.directory,
          createdAt: row.createdAt || null,
          updatedAt: row.updatedAt || null,
        },
      }));
    },
    async facts(candidate) {
      if (candidate.known.title !== null && candidate.known.title !== undefined) return withKnown(candidate, NO_FACTS);
      // 没有标题（OpenCode 的默认标题不算）：取第一句用户写的话
      const parsed = await readSession(candidate);
      return withKnown(candidate, { title: parsed?.firstPrompt ?? null });
    },
    async load(candidate) {
      const parsed = await readSession(candidate);
      if (parsed === null) throw new Error("the session is no longer in the database");
      return {
        ...withKnown(candidate, { title: parsed.firstPrompt, createdAt: parsed.firstAt, updatedAt: parsed.lastAt }),
        records: messagesToRecords(parsed.messages, parsed.userDisplays, parsed.compactions),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Reasonix：<root>/projects/<项目>/sessions/<id>.jsonl（+ .meta 侧车）
// ---------------------------------------------------------------------------

/** Reasonix 2026-09-18 起的新版会话库目录名（与 projects/ 同级，二进制帧容器，还不读） */
const REASONIX_V5_DIR = "desktop-sessions-v5";

const reasonix: ExternalAdapter = {
  entry: { path: ["projects"], type: "dir" },
  async candidates(root) {
    const projectsRoot = join(root, "projects");
    const files: { file: string; sourceId: string }[] = [];
    for (const project of await directoryEntries(projectsRoot)) {
      if (!project.isDirectory()) continue;
      const sessionsDir = join(projectsRoot, project.name, "sessions");
      for (const entry of await directoryEntries(sessionsDir).catch(() => [])) {
        if (entry.isFile() && isReasonixConversationFile(entry.name)) {
          files.push({ file: join(sessionsDir, entry.name), sourceId: entry.name.slice(0, -".jsonl".length) });
        }
      }
    }
    return (await statAll(files)).map((item) => ({
      source: "reasonix" as const,
      root,
      key: resolve(item.file),
      file: item.file,
      sourceId: item.sourceId,
      mtime: item.mtime,
      known: {},
    }));
  },
  async facts(candidate) {
    const meta = await readReasonixMeta(candidate.file);
    let title = meta?.title ?? null;
    if (title === null) {
      const parsed = reasonixToMessages(parseReasonixRows(await readHead(candidate.file)).rows, UNASSIGNED_PROVIDER_ID, null);
      title = parsed.firstPrompt;
    }
    return withKnown(candidate, { title, cwd: meta?.workspaceRoot ?? null, createdAt: meta?.createdAt ?? null, updatedAt: meta?.updatedAt ?? null });
  },
  async load(candidate) {
    const raw = await readBoundedText(candidate.file, "the session file");
    const meta = await readReasonixMeta(candidate.file);
    const parsed = reasonixToMessages(parseReasonixRows(raw).rows, UNASSIGNED_PROVIDER_ID, meta?.model ?? null);
    return {
      ...withKnown(candidate, {
        title: meta?.title ?? parsed.firstPrompt,
        cwd: meta?.workspaceRoot ?? null,
        createdAt: meta?.createdAt ?? parsed.firstAt,
        updatedAt: meta?.updatedAt ?? parsed.lastAt,
      }),
      records: messagesToRecords(parsed.messages, parsed.userDisplays),
    };
  },
  async notes(root) {
    const v5 = join(root, REASONIX_V5_DIR);
    try {
      if (!(await stat(v5)).isDirectory()) return [];
    } catch {
      return [];
    }
    return [`sessions in Reasonix's newer store (${v5}, from 2026-09-18) are not supported yet and are not listed`];
  },
};

// ---------------------------------------------------------------------------
// Proma：agent-sessions.json 索引 + sdk-config/sessions 下的 pi 本子（Claude 时代的会话是
// agent-sessions/<id>.jsonl 界面日志）
// ---------------------------------------------------------------------------

/** Proma 的界面日志（Claude 时代会话的本体，也是 pi 会话的用户原文来源） */
function promaRenderLog(root: string, id: string): string {
  return join(root, "agent-sessions", `${id}.jsonl`);
}

/** cwd 落在 Proma 自己的数据目录里（它的默认工作区）不算用户的文件夹 */
function promaCwd(cwd: string | null, roots: readonly string[]): string | null {
  if (cwd === null || cwd === "") return null;
  return roots.some((root) => isInside(root, cwd)) ? null : cwd;
}

const proma: ExternalAdapter = {
  entry: { path: ["agent-sessions.json"], type: "file" },
  async candidates(root, context) {
    const index = parsePromaSessions(await readFile(join(root, "agent-sessions.json"), "utf8"));
    let workspaces: ReturnType<typeof parsePromaWorkspaces> = [];
    try {
      workspaces = parsePromaWorkspaces(await readFile(join(root, "agent-workspaces.json"), "utf8"));
    } catch {
      // 工作区表读不到：cwd 退回本子 header 里的
    }
    const folderOf = (workspaceId: string | null): string | null =>
      workspaces.find((workspace) => workspace.id === workspaceId)?.projectRootPath ?? null;
    // 只列根会话：delegation 派出的子会话在母会话的工具结果里已有产出（同 OpenCode / ZCode）
    const items = [
      ...index.entries
        .filter((entry) => entry.parentSourceId === null)
        // 防御：索引里的路径必须落在某个 Proma 数据目录内，一份被手改过的索引不该让我们去读任意文件
        .filter((entry) => context.roots.some((dataRoot) => isInside(dataRoot, entry.piSessionFile)))
        .map((entry) => ({ entry, file: resolve(entry.piSessionFile), kind: "pi" as const })),
      ...index.claudeEntries
        .filter((entry) => entry.parentSourceId === null)
        .map((entry) => ({ entry, file: promaRenderLog(root, entry.id), kind: "claude-legacy" as const })),
    ];
    return (await statAll(items)).map((item) => ({
      source: "proma" as const,
      root,
      key: item.file,
      file: item.file,
      sourceId: item.entry.id,
      mtime: item.mtime,
      promaKind: item.kind,
      known: {
        title: item.entry.title === "" ? null : item.entry.title,
        cwd: promaCwd(folderOf(item.entry.workspaceId), context.roots),
        createdAt: item.entry.createdAt,
        updatedAt: item.entry.updatedAt,
      },
    }));
  },
  async facts(candidate, context) {
    if (candidate.known.cwd !== null && candidate.known.cwd !== undefined) return withKnown(candidate, NO_FACTS);
    if (candidate.promaKind !== "pi") return withKnown(candidate, NO_FACTS);
    // 工作区没有文件夹：取 pi 本子 header 的 cwd（第一行）
    const firstLine = (await readHead(candidate.file, 16 * 1024)).split("\n", 1)[0] ?? "";
    try {
      return withKnown(candidate, { cwd: promaCwd(parsePiBook(firstLine).header.cwd, context.roots) });
    } catch {
      return withKnown(candidate, NO_FACTS);
    }
  },
  async load(candidate, context) {
    const sourceBuffer = await readBoundedFile(candidate.file, EXTERNAL_SOURCE_MAX_BYTES, "the session file");
    const raw = sourceBuffer.toString("utf8");
    if (candidate.promaKind === "claude-legacy") {
      // 本体就是界面日志：用户行已是原文，这一步实际只解码 @file: 链接
      const { messages } = claudeRowsToMessages(parseClaudeRows(raw).rows, UNASSIGNED_PROVIDER_ID);
      const users = messages.flatMap((message) => (message.role === "user" ? [message.content] : []));
      return {
        ...withKnown(candidate, NO_FACTS),
        records: messagesToRecords(messages, promaUserDisplays(users, promaUserTexts(raw))),
      };
    }
    const book = parsePiBook(raw);
    // 用户原文：Proma 的界面日志与 pi 本子逐条配对（proma-user-text.ts）；读不到退回按格式剥
    let renderTexts: string[] | null = null;
    try {
      const log = await readBoundedFile(
        promaRenderLog(candidate.root, candidate.sourceId),
        EXTERNAL_TOTAL_MAX_BYTES - sourceBuffer.byteLength,
        "the session with its render log",
      );
      renderTexts = promaUserTexts(log.toString("utf8"));
    } catch (error) {
      if (error instanceof ExternalSessionSizeError) throw error;
      renderTexts = null;
    }
    const records = withUserTexts(entriesToRecords(branchEntries(book.entries)), promaUserTextMap(book.entries, renderTexts));
    return {
      ...withKnown(candidate, { cwd: promaCwd(book.header.cwd, context.roots), createdAt: book.header.timestamp || null }),
      records,
    };
  },
};

export const EXTERNAL_ADAPTERS: Record<ExternalSourceId, ExternalAdapter> = {
  "claude-code": claudeCode,
  codex,
  "kimi-code": kimiAdapter("kimi-code"),
  "kimi-work": kimiAdapter("kimi-work"),
  opencode: dbAdapter({
    source: "opencode",
    dbPath: ["opencode.db"],
    sessions: readOpencodeSessions,
    messages: readOpencodeMessages,
    bytes: opencodeSessionBytes,
  }),
  reasonix,
  zcode: dbAdapter({
    source: "zcode",
    dbPath: ["cli", "db", "db.sqlite"],
    sessions: readZcodeSessions,
    messages: readZcodeMessages,
    bytes: zcodeSessionBytes,
  }),
  proma,
};
