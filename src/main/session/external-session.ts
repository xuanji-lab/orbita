/**
 * 外部会话的只读入口。第一刀接 Kimi Code 与 Kimi Work：两者当前都是
 * sessions/<工作区>/<会话>/{state.json,agents/main/wire.jsonl}，正文解析共用
 * kimi-code.ts。这里只负责定位、列最近会话与按需读全文，不做来源开关与持久化。
 *
 * - list：stat 全部会话以取最近项，只对入选的最近 10 条读 state 与 wire 头部；
 *   没有标题时从头部取首条用户原文，不为列目录转换全部历史。
 * - load：按稳定 ref 找到源文件后读全文，SessionManager.inMemory 只作 Message →
 *   SessionRecord 的投影，源目录与 orbita 的会话目录都不写。
 * - ref：ext:<来源>:<源 wire 绝对路径的 sha256 前 16 位>。不依赖用户去源应用复制
 *   session id，也不落一张会过期的「ref → 路径」映射表。
 */
import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import {
  deriveSessionTitle,
  UNASSIGNED_MODEL_ID,
  UNASSIGNED_PROVIDER_ID,
  type SessionMeta,
  type SessionRecord,
} from "../../shared/session.ts";
import { branchEntries, entriesToRecords, readKimiWorkspaces } from "./importer.ts";
import { kimiBlobRefs, parseKimiSessionState, parseKimiWire, type KimiSessionState } from "./kimi-code.ts";
import { withUserTexts } from "./proma-user-text.ts";
import { isNotFound } from "../fs-errors.ts";

export type ExternalSessionSource = "kimi-code" | "kimi-work";

export interface ExternalSessionSummary {
  ref: string;
  source: ExternalSessionSource;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExternalSessionDetail {
  summary: ExternalSessionSummary;
  meta: SessionMeta;
  records: SessionRecord[];
}

/** read_task 依赖的最小只读接口；以后其他平台在同一个 seam 上加 adapter。 */
export interface ExternalSessionReader {
  list(): Promise<ExternalSessionSummary[]>;
  load(ref: string): Promise<ExternalSessionDetail | null>;
}

export interface ExternalSourceRoots {
  source: ExternalSessionSource;
  roots: readonly string[];
}

export interface KimiExternalSessionReaderDeps {
  /** 每次调用现取：自定义目录或应用数据目录变化后，不必重启主进程。 */
  sources(): Promise<readonly ExternalSourceRoots[]>;
  /** 源会话没记 cwd、所属工作区也找不到时的退路。 */
  defaultCwd: string;
}

interface SessionCandidate {
  source: ExternalSessionSource;
  sourceId: string;
  workspaceId: string;
  root: string;
  dir: string;
  stateFile: string;
  sourceFile: string;
  mtime: number;
}

const INDEX_LIMIT = 10;
const TITLE_HEAD_BYTES = 256 * 1024;

export function externalSessionSourceLabel(source: ExternalSessionSource): string {
  return source === "kimi-code" ? "Kimi Code" : "Kimi Work";
}

/** Kimi Work 当前桌面运行时在其 appData 下的 kimi-code 数据根。 */
export function kimiWorkDataRoot(appData: string): string {
  return join(appData, "kimi-desktop", "daimon-share", "daimon", "runtime", "kimi-code", "home");
}

function refOf(source: ExternalSessionSource, sourceFile: string): string {
  const hash = createHash("sha256").update(resolve(sourceFile)).digest("hex").slice(0, 16);
  return `ext:${source}:${hash}`;
}

function parseRef(ref: string): { source: ExternalSessionSource; hash: string } | null {
  const match = /^ext:(kimi-code|kimi-work):([0-9a-f]{16})$/.exec(ref);
  if (match === null) return null;
  return { source: match[1] as ExternalSessionSource, hash: match[2]! };
}

async function readState(file: string): Promise<KimiSessionState | null> {
  try {
    return parseKimiSessionState(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** 没标题时只读头部找首条提问；读不到完整会话也不影响目录。 */
async function firstPrompt(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    const buffer = Buffer.alloc(Math.min(TITLE_HEAD_BYTES, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseKimiWire(buffer.subarray(0, bytesRead).toString("utf8"), UNASSIGNED_PROVIDER_ID, new Map()).firstPrompt;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function listCandidates(source: ExternalSessionSource, root: string): Promise<SessionCandidate[]> {
  const sessionsDir = join(root, "sessions");
  let workspaceDirs;
  try {
    workspaceDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const workspaces = await readKimiWorkspaces(join(root, "workspaces.json"));
  const out: SessionCandidate[] = [];
  for (const workspace of workspaceDirs) {
    if (!workspace.isDirectory() || workspace.name.startsWith(".") || workspaces.deleted.has(workspace.name)) continue;
    const workspaceDir = join(sessionsDir, workspace.name);
    let sessions;
    try {
      sessions = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || session.name.startsWith(".")) continue;
      // Kimi Work 的 ctitle-* 是自动起标题的内部任务，不是源应用里给用户看的会话。
      if (source === "kimi-work" && session.name.startsWith("ctitle-")) continue;
      const dir = join(workspaceDir, session.name);
      const sourceFile = join(dir, "agents", "main", "wire.jsonl");
      try {
        const info = await stat(sourceFile);
        if (!info.isFile()) continue;
        out.push({
          source,
          sourceId: session.name,
          workspaceId: workspace.name,
          root,
          dir,
          stateFile: join(dir, "state.json"),
          sourceFile,
          mtime: info.mtimeMs,
        });
      } catch {
        // 扫描与源应用写入并发时，单条消失不挡其余会话。
      }
    }
  }
  return out;
}

async function summarize(candidate: SessionCandidate, defaultCwd: string): Promise<ExternalSessionSummary> {
  const state = await readState(candidate.stateFile);
  const prompt = state?.title === null || state?.title === undefined ? await firstPrompt(candidate.sourceFile) : null;
  // Kimi Work 在用户原文前塞 <meta …/> 给模型，有时还会把它写进自动 state 标题；两处都不是标题正文。
  const rawTitle = state?.title ?? prompt ?? "";
  const titleText = candidate.source === "kimi-work" ? rawTitle.replace(/^(?:\s*<meta\b[^>]*\/>\s*)+/, "") : rawTitle;
  const title =
    deriveSessionTitle(titleText) ||
    `${externalSessionSourceLabel(candidate.source)} session ${candidate.sourceId.slice(0, 8)}`;
  const workspaces = await readKimiWorkspaces(join(candidate.root, "workspaces.json"));
  return {
    ref: refOf(candidate.source, candidate.sourceFile),
    source: candidate.source,
    title,
    cwd: state?.cwd ?? workspaces.roots.get(candidate.workspaceId) ?? defaultCwd,
    createdAt: state?.createdAt ?? candidate.mtime,
    updatedAt: state?.updatedAt ?? candidate.mtime,
  };
}

/** Message[] → read_task 的记录，全在内存里；与导入器的用户原文口径一致。 */
function recordsOf(messages: readonly Message[], userDisplays: readonly (string | null)[], cwd: string): SessionRecord[] {
  const manager = SessionManager.inMemory(cwd);
  const hidden = new Set<string>();
  const texts = new Map<string, string>();
  let userIndex = 0;
  for (const message of messages) {
    const id = manager.appendMessage(message);
    if (message.role !== "user") continue;
    const display = userDisplays[userIndex] ?? null;
    userIndex += 1;
    if (display === null) hidden.add(id);
    else texts.set(id, display);
  }
  const records = entriesToRecords(branchEntries(manager.getEntries())).filter(
    (record) => record.role !== "user" || !hidden.has(record.id),
  );
  return withUserTexts(records, texts);
}

export function createKimiExternalSessionReader(deps: KimiExternalSessionReaderDeps): ExternalSessionReader {
  const candidatesFor = async (source?: ExternalSessionSource): Promise<SessionCandidate[]> => {
    const configured = await deps.sources();
    const groups = source === undefined ? configured : configured.filter((group) => group.source === source);
    const lists = await Promise.all(
      groups.flatMap((group) => group.roots.map((root) => listCandidates(group.source, root))),
    );
    return lists.flat();
  };

  return {
    async list() {
      const candidates = (await candidatesFor()).sort((a, b) => b.mtime - a.mtime).slice(0, INDEX_LIMIT);
      const summaries = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            return await summarize(candidate, deps.defaultCwd);
          } catch {
            return null;
          }
        }),
      );
      return summaries.flatMap((summary) => (summary === null ? [] : [summary]));
    },

    async load(ref) {
      const parsedRef = parseRef(ref);
      if (parsedRef === null) return null;
      const candidates = await candidatesFor(parsedRef.source);
      const candidate = candidates.find((item) => refOf(item.source, item.sourceFile).endsWith(parsedRef.hash));
      if (candidate === undefined) return null;
      const [raw, state] = await Promise.all([readFile(candidate.sourceFile, "utf8"), readState(candidate.stateFile)]);
      const blobs = new Map<string, string>();
      for (const sha of kimiBlobRefs(raw)) {
        try {
          blobs.set(sha, (await readFile(join(candidate.dir, "agents", "main", "blobs", sha))).toString("base64"));
        } catch {
          // 与导入器一致：图片缺席时由解析器换成文字说明。
        }
      }
      const wire = parseKimiWire(raw, UNASSIGNED_PROVIDER_ID, blobs);
      const summary = await summarize(candidate, deps.defaultCwd);
      const meta: SessionMeta = {
        id: summary.ref,
        title: summary.title,
        titleSource: "derived",
        cwd: summary.cwd,
        workspaceId: null,
        providerId: UNASSIGNED_PROVIDER_ID,
        modelId: wire.model ?? UNASSIGNED_MODEL_ID,
        mode: "plan",
        thinkingLevel: "medium",
        piSessionFile: null,
        pinned: false,
        archived: false,
        recentQueries: [],
        stats: null,
        createdAt: state?.createdAt ?? wire.firstAt ?? summary.createdAt,
        updatedAt: state?.updatedAt ?? wire.lastAt ?? summary.updatedAt,
        importedFrom: candidate.sourceFile,
        ...(wire.model === null ? null : { importedModel: wire.model }),
      };
      return { summary: { ...summary, createdAt: meta.createdAt, updatedAt: meta.updatedAt }, meta, records: recordsOf(wire.messages, wire.userDisplays, meta.cwd) };
    },
  };
}
