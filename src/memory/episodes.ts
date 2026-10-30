/**
 * 事件段（episode）状态机与落盘——**纯模块**：不 import electron，可被
 * `node --test` 直接加载。
 *
 * 一个会话同时最多一个「未收尾事件段」（open episode），存
 * `episodes/<sha1(sessionId)>.json`（**每轮原子写整份**——段是小 JSON，原子写
 * 让「写到一半被杀」只表现为旧完整段或新完整段）。收尾时搬进
 * `episodes/pending/<episodeId>.json`（待提取：三类逐类记账，提取完归档）。
 * 提完三类后归档进 `episodes/log.jsonl`（只追加，条目详情「所属事件段」的原文
 * 从这份账回看），pending 文件删除。
 *
 * 为什么开段与待提取段分两处：判「新事件」时旧段要收尾提取（三次模型调用，可能
 * 一分钟）、新段要立即落盘（进程死在提取里也不丢这一轮）——同一个
 * `<sha1(sessionId)>.json` 装不下两段。搬移顺序先写 pending 再删 open：半路被杀
 * 最坏同一段两处各一份，启动清扫按 episodeId 去重（pending 赢）兑住。
 *
 * 收尾时机（QUMem 的事件边界 + 三条时间兜底）：
 * 1. 新一轮落定、模型判「新事件」→ 收尾上一段（判「同一件事」就并进去）；
 * 2. 相邻轮间隔超 30 分钟 → 不问模型直接收尾（隔了半天的两轮必然不是同一件事，
 *    省一次调用）；
 * 3. 会话闲置 10 分钟（计时器）→ 收尾（别让段一直开着等下一轮）；
 * 4. 应用退出收不了尾（不能在退出路上跑模型）——开段留在盘上，**下次启动的清扫
 *    按 3 追认**：闲置超过 10 分钟的旧段收尾提取，没超的继续开着等续话。
 *
 * 提取是三类的三次模型调用，**逐类记账**（extracted）：进程死在提取半路，重启后
 * 只补没提成的类——已落盘的条目不会因为重提再写一份。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryEpisode, MemoryEpisodeTurn } from "../shared/memory.ts";
import { isNotFound } from "../main/fs-errors.ts";
import { writeTextAtomic } from "../main/atomic-write.ts";

/** 会话闲置多久收尾开段（毫秒）。 */
export const EPISODE_IDLE_CLOSE_MS = 10 * 60_000;
/** 相邻两轮间隔超过多久，不问模型直接判「新事件」（毫秒）。 */
export const EPISODE_GAP_CLOSE_MS = 30 * 60_000;

/** 二分类喂给模型的输入上限：只要判断话题连续性，头尾各一段足够。 */
const SEGMENT_INPUT_CHARS = 600;

/** 盘上的开段（内部形状：多收尾 / 提取记账两个运行态字段）。 */
export interface OpenEpisode {
  episodeId: string;
  sessionId: string;
  scopeId: string;
  fromTurn: number;
  toTurn: number;
  openedAt: number;
  lastAt: number;
  turns: MemoryEpisodeTurn[];
  /** 逐类提取记账：防「死在提取半路，重启后重复提取」。开段全 false，
   * 收尾搬进 pending 后逐类置 true；全 true 时归档进 log 并删文件。
   * （开段在 episodes/、收尾段在 episodes/pending/，位置本身就是状态。） */
  extracted: { fact: boolean; preference: boolean; insight: boolean };
}

/** 开段 → 契约的事件段（提条 / 归档 / 界面都用公开形状）。 */
export function toMemoryEpisode(episode: OpenEpisode): MemoryEpisode {
  return {
    episodeId: episode.episodeId,
    sessionId: episode.sessionId,
    scopeId: episode.scopeId,
    fromTurn: episode.fromTurn,
    toTurn: episode.toTurn,
    openedAt: episode.openedAt,
    lastAt: episode.lastAt,
    turns: episode.turns,
  };
}

/** 新起一段（第一轮落在里面）。 */
export function openEpisode(input: {
  sessionId: string;
  scopeId: string;
  turn: MemoryEpisodeTurn;
  now: number;
}): OpenEpisode {
  return {
    episodeId: `ep_${randomUUID()}`,
    sessionId: input.sessionId,
    scopeId: input.scopeId,
    fromTurn: input.turn.turn,
    toTurn: input.turn.turn,
    openedAt: input.now,
    lastAt: input.turn.at,
    turns: [input.turn],
    extracted: { fact: false, preference: false, insight: false },
  };
}

/**
 * 新一轮落定时对开段的判定——**不用模型就能判的先判**：
 * - ignore：重复 / 乱序轮（轮号不大于段尾）；
 * - start：没有开段，新起一段（无需问模型）；
 * - split：间隔超 EPISODE_GAP_CLOSE_MS，直接判「新事件」（无需问模型）；
 * - classify：间隔内，问模型「是否同一件事」。
 */
export type TurnAdmission =
  | { kind: "ignore" }
  | { kind: "start" }
  | { kind: "split" }
  | { kind: "classify" };

export function admissionOf(
  episode: OpenEpisode | null,
  turn: { turn: number; at: number },
): TurnAdmission {
  if (episode === null) return { kind: "start" };
  if (turn.turn <= episode.toTurn) return { kind: "ignore" };
  if (turn.at - episode.lastAt >= EPISODE_GAP_CLOSE_MS) return { kind: "split" };
  return { kind: "classify" };
}

/**
 * 会话回退到第 fromTurn 轮：段里轮号 ≥ fromTurn 的轮截掉。返回值三态：
 * - 原样那个对象 = 段里没有被撤回的轮（调用方不必写盘）；
 * - null = 整段都在被撤回的轮里（调用方丢掉这段）；
 * - 新对象 = 截剩的前半段：toTurn / lastAt 回到留下的最后一轮——admissionOf 的水位就此回落，
 *   重说的第 fromTurn 轮按新轮并入。提取记账（extracted）原样保留：已提成的类不重提，
 *   那些类里来自被撤回轮的条目由条目侧的停用处理（entries.ts planRevert）。
 */
export function truncateEpisode(episode: OpenEpisode, fromTurn: number): OpenEpisode | null {
  if (episode.toTurn < fromTurn) return episode;
  const kept = episode.turns.filter((turn) => turn.turn < fromTurn);
  const last = kept[kept.length - 1];
  if (last === undefined) return null;
  return { ...episode, fromTurn: kept[0]!.turn, toTurn: last.turn, lastAt: last.at, turns: kept };
}

/* ---------- 切段二分类（家务活模型的最短调用） ---------- */

export const SEGMENT_SYSTEM_PROMPT = `你是对话事件切分器。判断「下一句用户的话」与「上一句用户的话」是不是同一件事——
同一个任务、同一个话题、或同一段决策过程的继续。追问细节、补充信息、纠正方向都算同一件事；
换了个任务或话题就是新事件。
只输出 same 或 new 两个词之一，不要任何其他内容。`;

export function buildSegmentPrompt(input: { prevUser: string; nextUser: string }): string {
  const prev = input.prevUser.slice(-SEGMENT_INPUT_CHARS);
  const next = input.nextUser.slice(0, SEGMENT_INPUT_CHARS);
  return `<prev>\n${prev}\n</prev>\n<next>\n${next}\n</next>`;
}

/**
 * 模型回复 → 判定。same / new 之外的输出（含空 / 胡话）返回 null——
 * 调用方按 same 处理：并段比切段保守（少两次提取调用），判错的代价更小。
 */
export function parseSegmentReply(raw: string): "same" | "new" | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" ) return null;
  if (trimmed.includes("new")) return "new";
  if (trimmed.includes("same")) return "same";
  return null;
}

/* ---------- 落盘 ---------- */

function openFile(dir: string, sessionId: string): string {
  return join(dir, "episodes", `${createHash("sha1").update(sessionId).digest("hex")}.json`);
}

/** 历史开段（从历史生成）：与实时开段分目录存——同一会话正在实时聊时，两段各开各的。 */
function historyFile(dir: string, sessionId: string): string {
  return join(dir, "episodes", "history", `${createHash("sha1").update(sessionId).digest("hex")}.json`);
}

function pendingFile(dir: string, episodeId: string): string {
  return join(dir, "episodes", "pending", `${episodeId}.json`);
}

/** 开段 JSON 的逐字段校验：字段不齐当「没有开段」处理（坏文件不该挡住新段）。 */
export function parseOpenEpisode(value: unknown): OpenEpisode | null {
  if (typeof value !== "object" || value === null) return null;
  const suspect = value as {
    episodeId?: unknown;
    sessionId?: unknown;
    scopeId?: unknown;
    fromTurn?: unknown;
    toTurn?: unknown;
    openedAt?: unknown;
    lastAt?: unknown;
    turns?: unknown;
    extracted?: unknown;
  };
  if (typeof suspect.episodeId !== "string" || suspect.episodeId === "") return null;
  if (typeof suspect.sessionId !== "string" || suspect.sessionId === "") return null;
  if (typeof suspect.scopeId !== "string" || suspect.scopeId === "") return null;
  if (typeof suspect.fromTurn !== "number" || !Number.isInteger(suspect.fromTurn)) return null;
  if (typeof suspect.toTurn !== "number" || !Number.isInteger(suspect.toTurn)) return null;
  if (typeof suspect.openedAt !== "number" || !Number.isFinite(suspect.openedAt)) return null;
  if (typeof suspect.lastAt !== "number" || !Number.isFinite(suspect.lastAt)) return null;
  if (!Array.isArray(suspect.turns) || suspect.turns.length === 0) return null;
  const turns: MemoryEpisodeTurn[] = [];
  for (const turn of suspect.turns) {
    if (typeof turn !== "object" || turn === null) return null;
    const item = turn as { turn?: unknown; at?: unknown; userText?: unknown; assistantText?: unknown };
    if (typeof item.turn !== "number" || !Number.isInteger(item.turn)) return null;
    if (typeof item.at !== "number" || !Number.isFinite(item.at)) return null;
    if (typeof item.userText !== "string") return null;
    if (typeof item.assistantText !== "string") return null;
    turns.push({ turn: item.turn, at: item.at, userText: item.userText, assistantText: item.assistantText });
  }
  const extractedRaw =
    typeof suspect.extracted === "object" && suspect.extracted !== null
      ? (suspect.extracted as { fact?: unknown; preference?: unknown; insight?: unknown })
      : {};
  return {
    episodeId: suspect.episodeId,
    sessionId: suspect.sessionId,
    scopeId: suspect.scopeId,
    fromTurn: suspect.fromTurn,
    toTurn: suspect.toTurn,
    openedAt: suspect.openedAt,
    lastAt: suspect.lastAt,
    turns,
    extracted: {
      fact: extractedRaw.fact === true,
      preference: extractedRaw.preference === true,
      insight: extractedRaw.insight === true,
    },
  };
}

function parseFile(raw: string, label: string): OpenEpisode | null {
  try {
    return parseOpenEpisode(JSON.parse(raw));
  } catch {
    console.error(`[memory] ${label} 坏了，当没有这段处理（新段照常开）`);
    return null;
  }
}

async function readEpisodeFile(path: string, label: string): Promise<OpenEpisode | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
  return parseFile(raw, label);
}

export class EpisodeStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 该会话的开段；没有文件 / 文件坏了 = null（坏文件当没有开段，新段照常开）。 */
  loadOpen(sessionId: string): Promise<OpenEpisode | null> {
    return readEpisodeFile(openFile(this.dir, sessionId), `会话 ${sessionId} 的开段文件`);
  }

  /** 原子写整份（临时文件 + rename；段是小 JSON，这是 #228 改写路径的同款纪律）。 */
  async saveOpen(episode: OpenEpisode): Promise<void> {
    await writeTextAtomic(openFile(this.dir, episode.sessionId), `${JSON.stringify(episode)}\n`);
  }

  /** 开段收尾时搬进 pending 后删掉开段文件（幂等；先写 pending 再删 open，
   * 半路被杀最坏两处各一份，启动清扫按 episodeId 去重）。 */
  async removeOpen(sessionId: string): Promise<void> {
    await unlink(openFile(this.dir, sessionId)).catch((cause: unknown) => {
      if (!isNotFound(cause)) throw cause;
    });
  }

  /** 开段收尾时搬进 pending。文件名用 episodeId：同一会话可以同时有
   * 开段（新一轮的）与待提取段（上一段的），互不占用。 */
  async savePending(episode: OpenEpisode): Promise<void> {
    await writeTextAtomic(pendingFile(this.dir, episode.episodeId), `${JSON.stringify(episode)}\n`);
  }

  async loadPending(episodeId: string): Promise<OpenEpisode | null> {
    return readEpisodeFile(pendingFile(this.dir, episodeId), `待提取段 ${episodeId}`);
  }

  /** 提完归档后删掉待提取段（幂等：不在了就完事）。 */
  async removePending(episodeId: string): Promise<void> {
    await unlink(pendingFile(this.dir, episodeId)).catch((cause: unknown) => {
      if (!isNotFound(cause)) throw cause;
    });
  }

  /** 已提完的段归档进 episodes/log.jsonl（只追加；条目详情回看段原文用它）。 */
  async archive(episode: MemoryEpisode): Promise<void> {
    await mkdir(join(this.dir, "episodes"), { recursive: true });
    await appendFile(
      join(this.dir, "episodes", "log.jsonl"),
      `${JSON.stringify(episode)}\n`,
      "utf8",
    );
  }

  /** 归档的全部事件段（主进程记忆库读面用：条目的原话片段从段快照取）。坏行跳过。 */
  async listArchived(): Promise<MemoryEpisode[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, "episodes", "log.jsonl"), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const episodes: MemoryEpisode[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as MemoryEpisode;
        if (typeof parsed?.episodeId !== "string" || !Array.isArray(parsed?.turns)) continue;
        episodes.push(parsed);
      } catch {
        // 半截行：跳过
      }
    }
    return episodes;
  }

  /** 盘上全部待提取段（只扫 pending/，不碰各会话的开段文件）。每轮落定与回退都要问「这个会话
   * 有没有待提取段」，pending/ 只放收了尾还没提完的段（通常 0–2 个），开段文件却是每个活跃会话一份。 */
  async listPending(): Promise<OpenEpisode[]> {
    const dir = join(this.dir, "episodes", "pending");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const pending: OpenEpisode[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const episode = await readEpisodeFile(join(dir, name), `待提取段文件 ${name}`);
      if (episode !== null) pending.push(episode);
    }
    return pending;
  }

  /* ---------- 历史开段（从历史生成用；启动清扫不碰它们——它们按历史时间收尾，不按墙钟） ---------- */

  loadHistoryOpen(sessionId: string): Promise<OpenEpisode | null> {
    return readEpisodeFile(historyFile(this.dir, sessionId), `会话 ${sessionId} 的历史开段文件`);
  }

  async saveHistoryOpen(episode: OpenEpisode): Promise<void> {
    await writeTextAtomic(historyFile(this.dir, episode.sessionId), `${JSON.stringify(episode)}\n`);
  }

  async removeHistoryOpen(sessionId: string): Promise<void> {
    await unlink(historyFile(this.dir, sessionId)).catch((cause: unknown) => {
      if (!isNotFound(cause)) throw cause;
    });
  }

  async listHistoryOpen(): Promise<OpenEpisode[]> {
    const dir = join(this.dir, "episodes", "history");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const open: OpenEpisode[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const episode = await readEpisodeFile(join(dir, name), `历史开段文件 ${name}`);
      if (episode !== null) open.push(episode);
    }
    return open;
  }

  /**
   * 已经进过事件段的轮（会话 → 轮号集合）：归档、待提取、实时开段、历史开段四处的并集。
   * 从历史生成的去重账本就是它——段文件本身就是单一真相，不另记一份会和它对不上的账：
   * 实时整理过的、上次生成到一半的、停止时收尾的，都在这里。
   */
  async processedTurns(): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>();
    const add = (episode: { sessionId: string; turns: readonly MemoryEpisodeTurn[] }): void => {
      let set = out.get(episode.sessionId);
      if (set === undefined) {
        set = new Set();
        out.set(episode.sessionId, set);
      }
      for (const turn of episode.turns) set.add(turn.turn);
    };
    const [archived, all, history] = await Promise.all([this.listArchived(), this.listAll(), this.listHistoryOpen()]);
    for (const episode of archived) add(episode);
    for (const episode of all.open) add(episode);
    for (const episode of all.pending) add(episode);
    for (const episode of history) add(episode);
    return out;
  }

  /**
   * 盘上全部开段与待提取段（启动清扫用）。文件名是 sha1 / uuid 单向，回不出
   * sessionId，所以返回段本身——sessionId 在段里。单个文件坏了跳过它，不挡别的段。
   */
  async listAll(): Promise<{ open: OpenEpisode[]; pending: OpenEpisode[] }> {
    const open: OpenEpisode[] = [];
    const pending: OpenEpisode[] = [];
    const places = [
      { dir: join(this.dir, "episodes"), bucket: open, label: "开段文件" },
      { dir: join(this.dir, "episodes", "pending"), bucket: pending, label: "待提取段文件" },
    ] as const;
    for (const place of places) {
      let names: string[];
      try {
        names = await readdir(place.dir);
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const episode = await readEpisodeFile(join(place.dir, name), `${place.label} ${name}`);
        if (episode !== null) place.bucket.push(episode);
      }
    }
    return { open, pending };
  }
}
