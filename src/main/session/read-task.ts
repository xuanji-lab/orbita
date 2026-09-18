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
 */
import type { AgentEvent, ReadTaskCard, ReadTaskOutcome } from "../../shared/agent-ipc.ts";
import {
  isCompactedRecord,
  transcriptToMarkdown,
  type SessionDetail,
  type SessionMeta,
  type SessionRecord,
} from "../../shared/session.ts";

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
 * 把模型的引用翻成 session id。顺序：精确 id → 精确标题（大小写不敏感，
 * 重名算歧义）→ 唯一前缀（标题或 id）。候选里剔除当前会话；只剩当前会话
 * = 读自己（没有信息增量，纯烧上下文，拒绝）。
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
  const exactTitle = metas.filter((meta) => meta.title.trim().toLowerCase() === query);
  if (exactTitle.length === 1) {
    const meta = exactTitle[0];
    if (meta !== undefined) {
      return meta.id === excludeId ? { kind: "self" } : { kind: "found", id: meta.id };
    }
  }
  if (exactTitle.length > 1) {
    return { kind: "ambiguous", candidates: candidatesOf(exactTitle, excludeId) };
  }
  const prefixed = metas.filter(
    (meta) =>
      meta.title.trim().toLowerCase().startsWith(query) || meta.id.toLowerCase().startsWith(query),
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

function taskHeader(meta: SessionMeta, roundCount: number): string {
  const lines = [
    `Task "${meta.title === "" ? "(untitled)" : meta.title}" (id: ${meta.id})`,
    `Folder: ${meta.cwd} · Model: ${meta.providerId}/${meta.modelId} · ${roundCount} rounds`,
  ];
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
export function buildTaskBriefing(meta: SessionMeta, records: readonly SessionRecord[]): ReadTaskOutcome {
  const rounds = numberRounds(records);
  const card = cardOf(meta, "briefing", rounds.length);
  if (rounds.length === 0) {
    return {
      ok: true,
      card,
      text: `${taskHeader(meta, 0)}\n\nNo rounds yet — the task has no messages on disk.`,
    };
  }
  const head = [taskHeader(meta, rounds.length), outlineSection(records, rounds)];
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
    text: `${taskHeader(meta, rounds.length)}\n\nNo rounds could be read from disk.`,
  };
}

/** 指定轮全文：头部 + 每轮一段（轮内含界碑/工具/回答，同一格式化器）。 */
export function buildRoundsExcerpt(
  meta: SessionMeta,
  records: readonly SessionRecord[],
  spec: string,
): ReadTaskOutcome {
  const rounds = numberRounds(records);
  const selection = selectRounds(records, spec);
  if (selection.kind === "error") return { ok: false, error: selection.message };
  const card = cardOf(meta, "rounds", rounds.length, spec);
  const parts = [taskHeader(meta, rounds.length)];
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
 * readTaskRequest 的落点：列表解析引用（meta 都是小文件，与侧栏同一条读取路径）
 * → 读目标整账 → 组简报或轮切片。回执经 host 的 answerReadTask 回 agent 进程。
 */
export async function applyReadTask(
  sessions: SessionStoreReader,
  event: Extract<AgentEvent, { type: "readTaskRequest" }>,
): Promise<ReadTaskOutcome> {
  const metas = await sessions.list();
  const match = resolveTaskReference(event.task, metas, event.sessionId);
  if (match.kind === "self") {
    return {
      ok: false,
      error: `"${event.task}" is the current task — its content is already in this conversation.`,
    };
  }
  if (match.kind === "notFound") {
    return {
      ok: false,
      error: `No task matches "${event.task}". Quote the task title (or its id) exactly, or ask the user which task they mean.`,
    };
  }
  if (match.kind === "ambiguous") {
    const list = match.candidates.map((candidate) => `- ${candidate.title} (id: ${candidate.id})`).join("\n");
    return {
      ok: false,
      error: `"${event.task}" matches several tasks:\n${list}\nRetry with one exact title or id.`,
    };
  }
  const detail = await sessions.load(match.id);
  if (detail === null) {
    return { ok: false, error: `The task matched by "${event.task}" no longer exists on disk.` };
  }
  if (event.rounds === undefined) return buildTaskBriefing(detail.meta, detail.transcript);
  return buildRoundsExcerpt(detail.meta, detail.transcript, event.rounds);
}
