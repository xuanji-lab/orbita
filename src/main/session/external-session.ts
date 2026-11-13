/**
 * 外部会话的只读入口：别家 agent 工具（Claude Code、Codex、Kimi Code、Kimi Work、OpenCode、
 * Reasonix、ZCode、Proma）留在本机磁盘上的聊天记录，read_task 按 ref 读源头的最新内容。
 * **不导入、不复制**：Orbita 的会话库与源目录都不写；源头永远是真源（2026-11-13 用户裁决）。
 *
 * - list：每个来源各成一段，按「最近更新」各列最近几条（INDEX_PER_SOURCE；只看某个来源时
 *   SOURCE_INDEX_LIMIT）。列目录只 stat，只对入选的读头部（external-adapters.ts）。一个来源
 *   出错只记在它自己那一段，不连累别的来源。
 * - load：按 ref 找到源会话、读全文、在内存里投影成 SessionRecord。读不了的如实抛错：
 *   哪个来源、哪条、哪个文件、为什么。
 * - ref：`ext:<来源>:<源会话坐标的 sha256 前 16 位>`。坐标 = 源文件绝对路径（库来源是
 *   「库路径#会话 id」）。不依赖用户去源应用复制 id，也不落一张会过期的「ref → 路径」映射表；
 *   Kimi 两家沿用此前的写法，旧 ref 照样能读。
 *
 * 源坐标不进 SessionMeta：SessionMeta.importedFrom 是「导入幂等键」（shared/session.ts），用量统计
 * 按它排除导入会话；外部会话从来没进会话库，借这个字段会让两种语义在同一个词上撞车。
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_SOURCE_IDS, isExternalSourceId, type ExternalSourceId } from "../../shared/external-sources.ts";
import {
  deriveSessionTitle,
  UNASSIGNED_MODEL_ID,
  UNASSIGNED_PROVIDER_ID,
  type SessionMeta,
  type SessionRecord,
} from "../../shared/session.ts";
import {
  EXTERNAL_ADAPTERS,
  type ExternalAdapterContext,
  type ExternalCandidate,
  type ExternalSessionFacts,
} from "./external-adapters.ts";

export interface ExternalSessionSummary {
  ref: string;
  source: ExternalSourceId;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

/** 目录里一个来源的一段。 */
export interface ExternalSourceSection {
  source: ExternalSourceId;
  /** 这个来源发现的会话总数（只 stat 数出来的） */
  total: number;
  /** 最近更新的几条，新的在前 */
  summaries: ExternalSessionSummary[];
  /** 这一段读不全的原因（数据目录不在、库打不开、认不出的新格式……），如实列出 */
  problems: string[];
}

export interface ExternalSessionDetail {
  summary: ExternalSessionSummary;
  meta: SessionMeta;
  records: SessionRecord[];
  /** 源坐标（文件路径或「库路径#会话 id」）：报告与排障用，不进 SessionMeta（见模块头） */
  sourceFile: string;
}

export interface ExternalListOptions {
  /** 只列这一个来源（read_task 的 `ext:<来源>`），条数放宽到 SOURCE_INDEX_LIMIT */
  source?: ExternalSourceId;
}

/** read_task 依赖的最小只读接口。 */
export interface ExternalSessionReader {
  list(options?: ExternalListOptions): Promise<ExternalSourceSection[]>;
  /** 不存在返回 null；来源已关闭、读不了、超预算抛错（消息里写清来源、ref 与原因） */
  load(ref: string): Promise<ExternalSessionDetail | null>;
  /** 设置页用：每个有数据目录的来源（开关关着的也算）数会话、列问题，只 stat，不读头部 */
  inventory(): Promise<{ source: ExternalSourceId; total: number; problems: string[] }[]>;
}

export interface ExternalSourceRoots {
  source: ExternalSourceId;
  roots: readonly string[];
  /** 设置 › 外部来源里的开关；关着的来源不列，读它的 ref 时说明已关闭 */
  enabled: boolean;
}

export interface ExternalSessionReaderDeps {
  /** 每次调用现取：自定义目录、开关或应用数据目录变化后，不必重启主进程。 */
  sources(): Promise<readonly ExternalSourceRoots[]>;
  /** 源会话没记 cwd 时的退路。 */
  defaultCwd: string;
  /** Claude 桌面应用的会话清单目录（续接取代的旧文件不列）。 */
  claudeDesktopDir: string;
}

/**
 * 目录里每个来源列几条。read_task 不带参数的那次调用会把整个目录送进模型上下文：8 个来源
 * 各 5 条约 40 行，够认出「刚才在别的工具里聊的那几条」；要更早的，用 `ext:<来源>` 列这一个来源
 * 的最近 SOURCE_INDEX_LIMIT 条，或拿精确 ref 直读（ref 不受目录条数限制）。
 */
export const INDEX_PER_SOURCE = 5;
export const SOURCE_INDEX_LIMIT = 30;

const LABELS: Record<ExternalSourceId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "kimi-code": "Kimi Code",
  "kimi-work": "Kimi Work",
  opencode: "OpenCode",
  reasonix: "Reasonix",
  zcode: "ZCode",
  proma: "Proma",
};

export function externalSessionSourceLabel(source: ExternalSourceId): string {
  return LABELS[source];
}

function refOf(source: ExternalSourceId, key: string): string {
  return `ext:${source}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** `ext:<来源>:<16 位十六进制>`；认不出返回 null。 */
export function parseExternalRef(ref: string): { source: ExternalSourceId; hash: string } | null {
  const match = /^ext:([a-z-]+):([0-9a-f]{16})$/.exec(ref.trim());
  if (match === null || !isExternalSourceId(match[1])) return null;
  return { source: match[1], hash: match[2]! };
}

/** `ext:<来源>`（不带 id）：只列这一个来源；认不出返回 null。 */
export function parseExternalSourceRef(ref: string): ExternalSourceId | null {
  const match = /^ext:([a-z-]+):?$/.exec(ref.trim());
  return match !== null && isExternalSourceId(match[1]) ? match[1] : null;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 数据目录在不在（会话入口的文件 / 目录）。 */
async function entryExists(root: string, source: ExternalSourceId): Promise<boolean> {
  const { path, type } = EXTERNAL_ADAPTERS[source].entry;
  try {
    const info = await stat(join(root, ...path));
    return type === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 一个来源全部数据目录里的会话（只 stat）。目录不在、某个目录读不了都进 problems，
 * 其余目录照列；同一个源坐标在两个目录里出现（自定义目录与自动发现重叠）只留一份。
 */
async function sourceCandidates(
  group: ExternalSourceRoots,
  context: Omit<ExternalAdapterContext, "roots">,
): Promise<{ candidates: ExternalCandidate[]; problems: string[] }> {
  const adapter = EXTERNAL_ADAPTERS[group.source];
  const fullContext: ExternalAdapterContext = { ...context, roots: group.roots };
  const problems: string[] = [];
  const lists = await Promise.all(
    group.roots.map(async (root) => {
      if (!(await entryExists(root, group.source))) {
        problems.push(`no session data at ${root} (the folder was moved or deleted)`);
        return [];
      }
      try {
        const [candidates, notes] = await Promise.all([adapter.candidates(root, fullContext), adapter.notes?.(root) ?? []]);
        problems.push(...notes);
        return candidates;
      } catch (cause) {
        problems.push(`could not list ${root}: ${errorText(cause)}`);
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const candidates = lists.flat().filter((candidate) => {
    if (seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    return true;
  });
  return { candidates, problems };
}

/** 设置页数会话时读每个文件的开头多少字节（认格式用） */
const RECOGNIZE_HEAD_BYTES = 4096;
const RECOGNIZE_BATCH = 64;

async function headOf(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(RECOGNIZE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 设置页的一行：会话数与读不全的原因。库来源用 adapter.count（不复制库）；文件来源数 candidates，
 * 只算开头认得出格式的（一个格式认不出的文件不该算成「1 个会话」）。
 */
async function inventoryOf(
  group: ExternalSourceRoots,
  context: Omit<ExternalAdapterContext, "roots">,
): Promise<{ source: ExternalSourceId; total: number; problems: string[] }> {
  const adapter = EXTERNAL_ADAPTERS[group.source];
  const fullContext: ExternalAdapterContext = { ...context, roots: group.roots };
  const { count, recognize } = adapter;
  if (count !== undefined) {
    const problems: string[] = [];
    let total = 0;
    for (const root of group.roots) {
      if (!(await entryExists(root, group.source))) {
        problems.push(`no session data at ${root} (the folder was moved or deleted)`);
        continue;
      }
      try {
        total += await count(root, fullContext);
      } catch (cause) {
        problems.push(`could not list ${root}: ${errorText(cause)}`);
      }
    }
    return { source: group.source, total, problems };
  }
  const { candidates, problems } = await sourceCandidates(group, context);
  if (recognize === undefined) return { source: group.source, total: candidates.length, problems };
  // 分批开文件：一次全开，上千个会话文件会撞上进程的文件句柄上限（EMFILE），被当成认不出
  let total = 0;
  for (let index = 0; index < candidates.length; index += RECOGNIZE_BATCH) {
    const batch = candidates.slice(index, index + RECOGNIZE_BATCH);
    const recognized = await Promise.all(batch.map((candidate) => headOf(candidate.file).then(recognize, () => false)));
    total += recognized.filter(Boolean).length;
  }
  return { source: group.source, total, problems };
}

function summaryOf(candidate: ExternalCandidate, facts: ExternalSessionFacts, defaultCwd: string): ExternalSessionSummary {
  return {
    ref: refOf(candidate.source, candidate.key),
    source: candidate.source,
    title:
      deriveSessionTitle(facts.title ?? "") ||
      // 来源 id 常带固定前缀（session_、conv-、ses_、sess_），取前缀之后的 8 位才分得清
      `${externalSessionSourceLabel(candidate.source)} session ${candidate.sourceId.replace(/^(?:session_|conv-|sess?_)/, "").slice(0, 8)}`,
    cwd: facts.cwd ?? defaultCwd,
    createdAt: facts.createdAt ?? candidate.mtime,
    updatedAt: Math.max(facts.updatedAt ?? 0, candidate.mtime),
  };
}

/** 最后一条 assistant 记录的模型 id（各来源都把源模型名写在消息上）。 */
function lastModel(records: readonly SessionRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.role === "assistant" && record.model.id !== "unknown") return record.model.id;
  }
  return null;
}

export function createExternalSessionReader(deps: ExternalSessionReaderDeps): ExternalSessionReader {
  const context = { claudeDesktopDir: deps.claudeDesktopDir };

  return {
    async list(options = {}) {
      const groups = (await deps.sources()).filter(
        (group) => group.enabled && group.roots.length > 0 && (options.source === undefined || group.source === options.source),
      );
      const limit = options.source === undefined ? INDEX_PER_SOURCE : SOURCE_INDEX_LIMIT;
      const sections = await Promise.all(
        groups.map(async (group): Promise<ExternalSourceSection> => {
          const { candidates, problems } = await sourceCandidates(group, context);
          const recent = candidates.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
          const adapter = EXTERNAL_ADAPTERS[group.source];
          const fullContext = { ...context, roots: group.roots };
          const unknown: ExternalSessionFacts = { title: null, cwd: null, createdAt: null, updatedAt: null };
          // 头部读不了不挡目录：标题退回「来源 + id」，读全文时再如实报错
          const facts: ExternalSessionFacts[] =
            adapter.factsMany !== undefined && recent.length > 0
              ? await adapter.factsMany(recent, fullContext).catch(() => recent.map(() => unknown))
              : await Promise.all(recent.map((candidate) => adapter.facts(candidate, fullContext).catch(() => unknown)));
          const summaries = recent.map((candidate, index) => summaryOf(candidate, facts[index] ?? unknown, deps.defaultCwd));
          return { source: group.source, total: candidates.length, summaries, problems };
        }),
      );
      return sections.sort((a, b) => EXTERNAL_SOURCE_IDS.indexOf(a.source) - EXTERNAL_SOURCE_IDS.indexOf(b.source));
    },

    async inventory() {
      const groups = (await deps.sources()).filter((group) => group.roots.length > 0);
      return Promise.all(groups.map((group) => inventoryOf(group, context)));
    },

    async load(ref) {
      const parsed = parseExternalRef(ref);
      if (parsed === null) return null;
      const label = externalSessionSourceLabel(parsed.source);
      const group = (await deps.sources()).find((item) => item.source === parsed.source);
      if (group === undefined || group.roots.length === 0) {
        throw new Error(`${label} has no session data on this computer, so ${ref} cannot be read.`);
      }
      if (!group.enabled) {
        throw new Error(`${label} is turned off in Settings › External sources, so ${ref} is not read. Turn it on there to read it.`);
      }
      const { candidates } = await sourceCandidates(group, context);
      const candidate = candidates.find((item) => refOf(item.source, item.key) === ref.trim());
      if (candidate === undefined) return null;
      let loaded;
      try {
        loaded = await EXTERNAL_ADAPTERS[parsed.source].load(candidate, { ...context, roots: group.roots });
      } catch (cause) {
        throw new Error(`Could not read ${label} session ${ref} (${candidate.file}): ${errorText(cause)}`);
      }
      if (loaded.records.length === 0) {
        throw new Error(
          `Could not read ${label} session ${ref} (${candidate.file}): no messages in a format Orbita recognizes — ${label} may have changed its file format.`,
        );
      }
      const summary = summaryOf(candidate, loaded, deps.defaultCwd);
      const model = lastModel(loaded.records);
      const meta: SessionMeta = {
        id: summary.ref,
        title: summary.title,
        titleSource: "derived",
        cwd: summary.cwd,
        workspaceId: null,
        providerId: UNASSIGNED_PROVIDER_ID,
        modelId: model ?? UNASSIGNED_MODEL_ID,
        mode: "plan",
        thinkingLevel: "medium",
        piSessionFile: null,
        pinned: false,
        archived: false,
        recentQueries: [],
        stats: null,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      };
      return { summary, meta, records: loaded.records, sourceFile: candidate.key };
    },
  };
}
