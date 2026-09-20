/**
 * B-1：agent 的 read_task 工具在主进程的落地。
 *
 * 分层与 write-requests.ts 同款：纯核（引用匹配 / 轮号解析 / 简报构建）+
 * 一个 IO 胶水（applyReadTask，store 注入），node --test 直测。读盘只经
 * SessionStore——「正在跑读到什么」由存储层的既有语义回答：readLog 是快照、
 * 坏行跳过，meta 原子写，所以结果天然是一份干净前缀，头部如实标注快照时刻。
 *
 * **恒只读是结构保证，不靠纪律**（2026-09-18 立规）：applyReadTask 只拿
 * `SessionStoreReader`（最小只读视图，见下），这条路径上任何未来的写调用
 * ——append、改 meta、删会话——tsc 当场拒绝。写通路的唯一所有者是
 * recorder（那条会话自己跑出事件时）与用户的显式操作。
 *
 * 给多少（2026-09-18 裁决）：一次调用 = 头部 + 全部界碑摘要 + 单行目录 +
 * 最近 10 轮全文；拿目录上的轮号再调 `rounds` 精准取旧的。摘要不算额外
 * 开销——界碑本来就是「此前一切」的压缩，正好补轮窗外的洞。
 *
 * 目录模式（2026-09-21）：`task` 缺席 = 列当前工作区的兄弟 task。模型之前没有
 * 任何会话索引，只能靠 ambiguous 报错里的候选用前缀试探（实测 12 次调用、
 * 2m12s，最后还读错了工作区）。引用匹配同时改成同工作区优先。
 */
import type { AgentEvent, ReadTaskCard, ReadTaskOutcome } from "../../shared/agent-ipc.ts";
import {
  isCompactedRecord,
  transcriptToMarkdown,
  type SessionDetail,
  type SessionMeta,
  type SessionRecord,
} from "../../shared/session.ts";
import type { Workspace } from "../../shared/workspace.ts";

/** 简报默认带全文的最近轮数（裁决：10，不设参数——多了用 rounds 精准取） */
const BRIEFING_RECENT_ROUNDS = 10;
/** 简报总长兜底：超出就减全文轮数（保住最后一轮——结论通常在那），如实标注 */
const BRIEFING_MAX_CHARS = 60_000;
/** 目录行的截断宽度：一行要能扫读 */
const OUTLINE_LINE_MAX = 80;
/** 界碑摘要进目录的行数上限——摘要是「大致浏览」的，不是重读一遍前文 */
const SUMMARY_MAX_LINES = 40;

// ── 引用匹配 ──

export interface TaskCandidate {
  id: string;
  title: string;
}

export type TaskRefMatch =
  | { kind: "found"; id: string }
  | { kind: "self" }
  | { kind: "notFound" }
  | { kind: "ambiguous"; candidates: TaskCandidate[] };

/**
 * 当前会话所在工作区。metas 里找不到自己（新会话还没落盘）视为 null——
 * 与侧栏 TASKS 组同一口径：`workspaceId === null` 的会话彼此算同一组。
 */
function workspaceOf(metas: readonly SessionMeta[], sessionId: string): string | null {
  return metas.find((meta) => meta.id === sessionId)?.workspaceId ?? null;
}

/** 兄弟会话：同工作区、排除自己，按 updatedAt 倒序（最近的先看见）。 */
function siblingsOf(metas: readonly SessionMeta[], sessionId: string): SessionMeta[] {
  const workspaceId = workspaceOf(metas, sessionId);
  return metas
    .filter((meta) => meta.id !== sessionId && meta.workspaceId === workspaceId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 把模型的引用翻成 session id。顺序：精确 id（全仓）→ 精确标题 → 唯一前缀
 * （标题或 id）。
 *
 * **标题与前缀都是「同工作区优先」**（2026-09-21 复验后加）：用户说「之前那条
 * task」指的几乎总是侧栏里并排的那条；跨工作区重名把它压成 ambiguous，模型就只能
 * 靠前缀一条条试——实测 12 次调用 2m12s 还读错了人。工作区内有命中就在工作区内定
 * 结论，工作区内一个都没有才退回全仓。`workspaceId === null` 的会话彼此算同一组。
 *
 * 候选里剔除当前会话；只剩当前会话 = 读自己（没有信息增量，纯烧上下文，拒绝）。
 */
export function resolveTaskReference(
  ref: string,
  metas: readonly SessionMeta[],
  excludeId: string,
): TaskRefMatch {
  const query = ref.trim().toLowerCase();
  if (query === "") return { kind: "notFound" };
  const exactId = metas.find((meta) => meta.id === ref.trim());
  if (exactId !== undefined) {
    return exactId.id === excludeId ? { kind: "self" } : { kind: "found", id: exactId.id };
  }
  const workspaceId = workspaceOf(metas, excludeId);
  const scoped = metas.filter((meta) => meta.workspaceId === workspaceId);
  // 同工作区先试，空了才退回全仓——两级都用同一个谓词
  const narrow = <T>(pick: (pool: readonly SessionMeta[]) => T[]): T[] => {
    const inScope = pick(scoped);
    return inScope.length > 0 ? inScope : pick(metas);
  };
  const exactTitle = narrow((pool) => pool.filter((meta) => meta.title.trim().toLowerCase() === query));
  if (exactTitle.length === 1) {
    const meta = exactTitle[0];
    if (meta !== undefined) {
      return meta.id === excludeId ? { kind: "self" } : { kind: "found", id: meta.id };
    }
  }
  if (exactTitle.length > 1) {
    return { kind: "ambiguous", candidates: candidatesOf(exactTitle, excludeId) };
  }
  const prefixed = narrow((pool) =>
    pool.filter(
      (meta) =>
        meta.title.trim().toLowerCase().startsWith(query) || meta.id.toLowerCase().startsWith(query),
    ),
  );
  if (prefixed.length === 0) return { kind: "notFound" };
  const visible = candidatesOf(prefixed, excludeId);
  if (visible.length === 0) return { kind: "self" };
  if (visible.length === 1) {
    const only = visible[0];
    return only !== undefined ? { kind: "found", id: only.id } : { kind: "notFound" };
  }
  return { kind: "ambiguous", candidates: visible.slice(0, 5) };
}

/** 候选列表：剔除当前会话，标题空着给占位。 */
function candidatesOf(metas: readonly SessionMeta[], excludeId: string): TaskCandidate[] {
  return metas
    .filter((meta) => meta.id !== excludeId)
    .map((meta) => ({ id: meta.id, title: meta.title === "" ? "(untitled)" : meta.title }));
}

// ── 轮号 ──

/** 一轮 = 一条 user 记录到下一条 user 记录之前（含界碑、工具、回答）。轮号 1 起。 */
export interface TaskRound {
  number: number;
  startIndex: number;
  endIndex: number;
}

export function numberRounds(records: readonly SessionRecord[]): TaskRound[] {
  const starts: number[] = [];
  for (let index = 0; index < records.length; index++) {
    if (records[index]?.role === "user") starts.push(index);
  }
  return starts.map((startIndex, ordinal) => {
    const next = starts[ordinal + 1];
    return { number: ordinal + 1, startIndex, endIndex: next ?? records.length };
  });
}

export type RoundsSelection =
  | { kind: "ok"; rounds: TaskRound[] }
  | { kind: "error"; message: string };

/**
 * 解析轮号串："3"、"2-5"、"1,4" 都是合法形状；越界、倒序、非数字都报错
 * 并带有效范围——报错是给模型改道用的，要能指导下一次调用。
 */
export function selectRounds(records: readonly SessionRecord[], spec: string): RoundsSelection {
  const rounds = numberRounds(records);
  if (rounds.length === 0) return { kind: "error", message: "This task has no rounds to fetch." };
  const valid = `1-${rounds.length}`;
  const picked = new Map<number, TaskRound>();
  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (/^\d+$/.test(piece)) {
      const number = Number(piece);
      const round = rounds[number - 1];
      if (round === undefined) {
        return { kind: "error", message: `Round ${piece} does not exist; valid rounds are ${valid}.` };
      }
      picked.set(number, round);
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(piece);
    if (range === null) {
      return { kind: "error", message: `Cannot parse rounds "${piece}"; use "3", "2-5" or "1,4".` };
    }
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from < 1 || to > rounds.length || from > to) {
      return { kind: "error", message: `Rounds "${piece}" out of range; valid rounds are ${valid}.` };
    }
    for (let number = from; number <= to; number++) {
      const round = rounds[number - 1];
      if (round !== undefined) picked.set(number, round);
    }
  }
  const ordered = [...picked.values()].sort((a, b) => a.number - b.number);
  return { kind: "ok", rounds: ordered };
}

// ── 简报构建 ──

/** 机器事实用 ISO 8601 UTC（shared/session.ts 的 iso 同款，那边没导出）。 */
function iso(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clipLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n… (truncated, ${lines.length} lines in total)`;
}

/** 单行截断：目录行只要首行，扫读用 */
function firstLine(text: string, max = OUTLINE_LINE_MAX): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 记录里第一个 text 块的文本（没有 text 块 = 空串） */
function firstTextOf(record: SessionRecord | undefined): string {
  if (record === undefined || record.role === "compacted") return "";
  for (const block of record.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** 一轮的结论行：最后一条带正文的 assistant 记录的首行 */
function lastAssistantLine(records: readonly SessionRecord[]): string {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record === undefined || record.role !== "assistant") continue;
    const text = firstTextOf(record);
    if (text.trim() !== "") return firstLine(text);
  }
  return "";
}

/** 工作区的人话：有名字就报名字，null = 侧栏那组不属于任何工作区的 task。 */
function workspaceLabel(workspaceName: string | null): string {
  return workspaceName === null ? "(outside any workspace)" : workspaceName;
}

/**
 * 兄弟索引的唯一格式化器：目录模式与 notFound / ambiguous 报错共用同一份，
 * 模型无论从哪条路径撞上都能一次改道，不用再拿前缀试探。
 */
function formatTaskIndex(
  metas: readonly SessionMeta[],
  sessionId: string,
  workspaceName: string | null,
): string {
  const siblings = siblingsOf(metas, sessionId);
  const where =
    workspaceName === null ? "Tasks outside any workspace" : `Workspace "${workspaceName}"`;
  if (siblings.length === 0) {
    return `${where}: this is the only task here — there is no other task to read.`;
  }
  const lines = [
    `${where}: ${siblings.length} other task${siblings.length === 1 ? "" : "s"}, most recently updated first:`,
  ];
  for (const meta of siblings) {
    lines.push(
      `- ${meta.title === "" ? "(untitled)" : meta.title} (id: ${meta.id}) · updated ${iso(meta.updatedAt)} · ${meta.providerId}/${meta.modelId}`,
    );
  }
  lines.push("Call read_task again with `task` set to one exact title or id to read that task.");
  return lines.join("\n");
}

/**
 * 目录模式（`task` 缺席的那次调用）：列当前会话的兄弟 task。
 * 没有读任何一条账，所以没有任务卡（`card: null`）——renderer 的卡是「跳到某条」，
 * 目录没有那个「某条」。
 */
export function buildTaskIndex(
  metas: readonly SessionMeta[],
  sessionId: string,
  workspaceName: string | null,
): ReadTaskOutcome {
  return { ok: true, card: null, text: formatTaskIndex(metas, sessionId, workspaceName) };
}

function taskHeader(meta: SessionMeta, roundCount: number, workspaceName?: string | null): string {
  const lines = [
    `Task "${meta.title === "" ? "(untitled)" : meta.title}" (id: ${meta.id})`,
  ];
  if (workspaceName !== undefined) lines.push(`Workspace: ${workspaceLabel(workspaceName)}`);
  lines.push(
    `Folder: ${meta.cwd} · Model: ${meta.providerId}/${meta.modelId} · ${roundCount} rounds`,
  );
  const stats = meta.stats;
  if (stats !== null) {
    lines.push(
      `Usage so far: ${stats.tokens.total.toLocaleString("en-US")} tokens, $${stats.cost.toFixed(4)}`,
    );
  }
  lines.push(`Snapshot read from disk as of ${iso(meta.updatedAt)}; the task may have progressed since.`);
  return lines.join("\n");
}

function outlineSection(records: readonly SessionRecord[], rounds: readonly TaskRound[]): string {
  const lines = ["Contents (round numbers are for the `rounds` parameter):"];
  for (const round of rounds) {
    const slice = records.slice(round.startIndex, round.endIndex);
    const userLine = firstLine(firstTextOf(slice[0]));
    lines.push(`${round.number}. ${userLine === "" ? "(no text)" : userLine}`);
    const answerLine = lastAssistantLine(slice);
    if (answerLine !== "") lines.push(`   → ${answerLine}`);
  }
  return lines.join("\n");
}

function compactedSection(records: readonly SessionRecord[]): string | null {
  const marks = records.filter(isCompactedRecord);
  if (marks.length === 0) return null;
  const lines = ["Compacted earlier context (already-summarized history):"];
  for (const mark of marks) {
    lines.push(`- [compacted at ${iso(mark.timestamp)}, ≈${mark.tokensBefore.toLocaleString("en-US")} tokens before]`);
    for (const line of clipLines(mark.summary.trim(), SUMMARY_MAX_LINES).split("\n")) {
      lines.push(`  > ${line}`);
    }
  }
  return lines.join("\n");
}

function cardOf(meta: SessionMeta, mode: ReadTaskCard["mode"], roundCount: number, rounds?: string): ReadTaskCard {
  return {
    sessionId: meta.id,
    title: meta.title === "" ? "(untitled)" : meta.title,
    mode,
    ...(rounds === undefined ? {} : { rounds }),
    roundCount,
  };
}

/**
 * 简报（rounds 缺席的那次调用）：头部 + 目录 + 界碑摘要 + 最近轮全文。
 * 全文轮数超预算就从一半往上减（保最后一轮——结论通常在那），并如实标注
 * 被减掉这件事：截断不能是悄悄的。
 */
export function buildTaskBriefing(
  meta: SessionMeta,
  records: readonly SessionRecord[],
  workspaceName?: string | null,
): ReadTaskOutcome {
  const rounds = numberRounds(records);
  const card = cardOf(meta, "briefing", rounds.length);
  if (rounds.length === 0) {
    return {
      ok: true,
      card,
      text: `${taskHeader(meta, 0, workspaceName)}\n\nNo rounds yet — the task has no messages on disk.`,
    };
  }
  const head = [taskHeader(meta, rounds.length, workspaceName), outlineSection(records, rounds)];
  const compacted = compactedSection(records);
  if (compacted !== null) head.push(compacted);
  const wanted = Math.min(BRIEFING_RECENT_ROUNDS, rounds.length);
  let taken = wanted;
  for (;;) {
    const start = rounds[rounds.length - taken]?.startIndex;
    if (start === undefined) break;
    const recentBody = transcriptToMarkdown(records.slice(start));
    const trimmed =
      taken < wanted
        ? `\n(only the last ${taken} of ${wanted} rounds shown in full to stay under the size budget; fetch earlier rounds with the \`rounds\` parameter)`
        : "";
    const text = `${head.join("\n\n")}\n\n--- Last ${taken} round${taken === 1 ? "" : "s"} in full ---\n\n${recentBody}${trimmed}`;
    if (text.length <= BRIEFING_MAX_CHARS || taken === 1) return { ok: true, card, text };
    taken = Math.max(1, Math.floor(taken / 2));
  }
  // rounds 表与 records 失配（理论不可达）：按空会话如实说
  return {
    ok: true,
    card,
    text: `${taskHeader(meta, rounds.length, workspaceName)}\n\nNo rounds could be read from disk.`,
  };
}

/** 指定轮全文：头部 + 每轮一段（轮内含界碑/工具/回答，同一格式化器）。 */
export function buildRoundsExcerpt(
  meta: SessionMeta,
  records: readonly SessionRecord[],
  spec: string,
  workspaceName?: string | null,
): ReadTaskOutcome {
  const rounds = numberRounds(records);
  const selection = selectRounds(records, spec);
  if (selection.kind === "error") return { ok: false, error: selection.message };
  const card = cardOf(meta, "rounds", rounds.length, spec);
  const parts = [taskHeader(meta, rounds.length, workspaceName)];
  for (const round of selection.rounds) {
    const slice = records.slice(round.startIndex, round.endIndex);
    parts.push(`--- Round ${round.number} ---\n\n${transcriptToMarkdown(slice)}`);
  }
  return { ok: true, card, text: parts.join("\n\n") };
}

// ── IO 胶水 ──

/**
 * applyReadTask 对会话存储的全部所需——**最小只读视图**。
 * 「read_task 恒只读」不靠纪律，靠这里：参数收窄成只有 list / load 两个读方法，
 * 这条路径上将来任何写调用（append、改 meta、删会话）tsc 当场拒绝。
 * SessionStore 结构化满足本接口（真 store 直接传入），测试与生产同型。
 */
export interface SessionStoreReader {
  list(): Promise<SessionMeta[]>;
  load(id: string): Promise<SessionDetail | null>;
}

/**
 * 工作区的最小只读视图（同上）：只要名字，所以只要 list。
 * WorkspaceStore 结构化满足本接口，测试给 stub。
 */
export interface WorkspaceStoreReader {
  list(): Promise<Workspace[]>;
}

/**
 * readTaskRequest 的落点：列表解析引用（meta 都是小文件，与侧栏同一条读取路径）
 * → 读目标整账 → 组简报或轮切片。回执经 host 的 answerReadTask 回 agent 进程。
 */
export async function applyReadTask(
  sessions: SessionStoreReader,
  event: Extract<AgentEvent, { type: "readTaskRequest" }>,
  workspaces: WorkspaceStoreReader,
): Promise<ReadTaskOutcome> {
  const metas = await sessions.list();
  const named = new Map((await workspaces.list()).map((workspace) => [workspace.id, workspace.name]));
  /** 工作区 id → 名字；null 与已删工作区同归「不属于任何工作区」 */
  const nameOf = (workspaceId: string | null): string | null =>
    workspaceId === null ? null : (named.get(workspaceId) ?? null);
  const here = nameOf(workspaceOf(metas, event.sessionId));
  const ref = event.task?.trim() ?? "";
  // 目录模式：模型不拿引用就问，答「这个工作区里还有哪些 task」
  if (ref === "") return buildTaskIndex(metas, event.sessionId, here);
  const match = resolveTaskReference(ref, metas, event.sessionId);
  if (match.kind === "self") {
    return {
      ok: false,
      error: `"${ref}" is the current task — its content is already in this conversation.`,
    };
  }
  // 没命中 / 撞歧义都把兄弟索引附在后面：一次就能改道，不用再拿前缀试探
  const index = formatTaskIndex(metas, event.sessionId, here);
  if (match.kind === "notFound") {
    return {
      ok: false,
      error: `No task matches "${ref}". Quote the task title (or its id) exactly.\n\n${index}`,
    };
  }
  if (match.kind === "ambiguous") {
    const list = match.candidates.map((candidate) => `- ${candidate.title} (id: ${candidate.id})`).join("\n");
    return {
      ok: false,
      error: `"${ref}" matches several tasks:\n${list}\nRetry with one exact title or id.\n\n${index}`,
    };
  }
  const detail = await sessions.load(match.id);
  if (detail === null) {
    return { ok: false, error: `The task matched by "${ref}" no longer exists on disk.` };
  }
  const target = nameOf(detail.meta.workspaceId);
  if (event.rounds === undefined) return buildTaskBriefing(detail.meta, detail.transcript, target);
  return buildRoundsExcerpt(detail.meta, detail.transcript, event.rounds, target);
}
