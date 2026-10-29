/**
 * 记忆条目落盘——**纯模块**：不 import electron，可被 `node --test` 直接加载
 * （session/store.ts、#228 的 memory/store.ts 同款先例）。
 *
 * 盘上布局（dir 由主进程 init 时给，= `<userData>/memory/`）：
 *
 *   user.jsonl                     user 层条目（所有工作区共享）
 *   <sha1(scopeId)>.jsonl          workspace 层条目（一个作用域一个文件）
 *   episodes/<sha1(sessionId)>.json 会话的未收尾事件段（episodes.ts 管）
 *   episodes/log.jsonl             已提完的事件段存档（episodes.ts 管）
 *   injections.jsonl               注入账本（service-core 管）
 *
 * 为什么按作用域分文件（#228 的结论照旧）：召回永远只问「user 层 + 一个工作区层」，
 * 分文件让读就是读一两个小文件。文件名 sha1 的理由也照旧：cwd 是任意绝对路径，
 * 原样当文件名在 Windows 上是一堆非法字符；user.jsonl 不是 hex，不会与哈希撞名。
 *
 * 写入口径与 SessionStore 一致：**只追加**（appendFile 一行一条，O_APPEND 保证单次
 * 追加不撕裂），读全量、坏行跳过。本 PR 没有改写条目的路径（冲突不改旧条目、
 * muted / 升层的写入口在后续界面 PR），所以这个文件里没有整份重写。
 *
 * 旧实验（#228 时代）留下的 `<sha1>.jsonl` 行缺 type / layer，解析按坏行跳过，
 * 不迁移——那是没合进 main 的实验数据。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MemoryEntry,
  MemoryEntryType,
  MemoryEpisode,
  MemoryLayer,
  MemorySource,
  MemoryStatus,
} from "../shared/memory.ts";
import { isNotFound } from "../main/fs-errors.ts";

/**
 * 提取产出、待落盘的条目（extract.ts 解析模型回复铸成这个）。与 MemoryEntry 分开：
 * id / at / 出处 / episodeId 的分配权在落盘侧（appendScope），提取侧不该能伪造。
 * 全部服务进程内部使用，不跨进程，所以不放 shared。
 */
export interface MemoryDraft {
  type: MemoryEntryType;
  text: string;
  /** 偏好的理由 / 经验的依据；事实可空 */
  reason?: string;
  keywords: string[];
  /** 模型给的支撑轮号（appendScope 会夹回段内集合） */
  turns: number[];
  /** 跨工作区通用的偏好 → pendingPromote（只对 preference 生效，见 appendScope 调用方） */
  pendingPromote?: boolean;
  /** 与旧偏好矛盾（id 已在候选表里验过）；只建议，不改旧条目 */
  conflictWith?: string;
}

/** 契约说关键词 ≤8 个（shared/memory.ts）。超了截断——多给的关键词只会把打分稀释。 */
const KEYWORD_LIMIT = 8;

const USER_LAYER_FILE = "user.jsonl";
const LOG_SUFFIX = ".jsonl";

/* ---------- 行解析：字段不齐的行跳过，宽松字段缺席按默认解读 ---------- */

const TYPES: readonly MemoryEntryType[] = ["fact", "preference", "insight"];
const SOURCES: readonly MemorySource[] = ["chat"];
const STATUSES: readonly MemoryStatus[] = ["active", "muted"];

function enumOf<T extends string>(value: unknown, table: readonly T[]): T | undefined {
  return typeof value === "string" && (table as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * 逐字段校验一行 JSONL；必填字段不齐返回 null。**长着条目的脸但不齐的行跳过**——
 * 半截条目注入 prompt 比少一条更难查（session/store.ts 的同一条纪律）。
 * 可选字段（reason / status / pendingPromote / conflictWith）缺席 / 类型不对都当
 * 缺席，一条坏的可选字段不值得丢整条记忆。
 *
 * 放在服务侧而不是 shared/memory.ts：契约文件只放形状，解析是落盘侧的实现细节
 * （#228 的先例同款）。
 */
export function parseMemoryEntry(value: unknown): MemoryEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const suspect = value as {
    id?: unknown;
    type?: unknown;
    text?: unknown;
    reason?: unknown;
    keywords?: unknown;
    layer?: unknown;
    scopeId?: unknown;
    sessionId?: unknown;
    turns?: unknown;
    at?: unknown;
    episodeId?: unknown;
    source?: unknown;
    status?: unknown;
    pendingPromote?: unknown;
    conflictWith?: unknown;
  };
  if (typeof suspect.id !== "string" || suspect.id === "") return null;
  if (typeof suspect.text !== "string" || suspect.text === "") return null;
  if (typeof suspect.sessionId !== "string" || suspect.sessionId === "") return null;
  if (typeof suspect.at !== "number" || !Number.isFinite(suspect.at)) return null;
  if (typeof suspect.episodeId !== "string" || suspect.episodeId === "") return null;
  if (!Array.isArray(suspect.keywords)) return null;
  if (!Array.isArray(suspect.turns) || suspect.turns.length === 0) return null;
  const type = enumOf(suspect.type, TYPES);
  if (type === undefined) return null;
  const layer = enumOf(suspect.layer, ["user", "workspace"] as const satisfies readonly MemoryLayer[]);
  if (layer === undefined) return null;
  if (layer === "workspace" && (typeof suspect.scopeId !== "string" || suspect.scopeId === "")) return null;
  const source = enumOf(suspect.source, SOURCES);
  if (source === undefined) return null;
  const status = enumOf(suspect.status, STATUSES);
  const keywords: string[] = [];
  for (const keyword of suspect.keywords) {
    if (typeof keyword !== "string") return null;
    keywords.push(keyword);
  }
  const turns: number[] = [];
  for (const turn of suspect.turns) {
    if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) return null;
    turns.push(turn);
  }
  return {
    id: suspect.id,
    type,
    text: suspect.text,
    keywords,
    layer,
    ...(layer === "workspace" ? { scopeId: suspect.scopeId as string } : null),
    sessionId: suspect.sessionId,
    turns: [...new Set(turns)].sort((a, b) => a - b),
    at: suspect.at,
    episodeId: suspect.episodeId,
    source,
    ...(typeof suspect.reason === "string" && suspect.reason.trim() !== "" ? { reason: suspect.reason } : null),
    ...(status !== undefined ? { status } : null),
    ...(suspect.pendingPromote === true ? { pendingPromote: true } : null),
    ...(typeof suspect.conflictWith === "string" && suspect.conflictWith !== ""
      ? { conflictWith: suspect.conflictWith }
      : null),
  };
}

/** 去重键：trim + 内部空白折叠。逐字重复才归并，措辞有差的就是另一条记忆。 */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export class MemoryEntryStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** scopeId → 盘上文件名（sha1 hex，定长且恒合法）。 */
  tokenOf(scopeId: string): string {
    return createHash("sha1").update(scopeId).digest("hex");
  }

  private async readLayer(path: string): Promise<MemoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const entries: MemoryEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = parseMemoryEntry(JSON.parse(line));
        if (parsed !== null) entries.push(parsed);
      } catch {
        // 半截行：跳过它，前面读到的好行照常返回
      }
    }
    return entries;
  }

  /** user 层全部条目，落盘顺序。文件不存在 = 一条都没有；读不了照抛（同 #228 纪律）。 */
  listUser(): Promise<MemoryEntry[]> {
    return this.readLayer(join(this.dir, USER_LAYER_FILE));
  }

  /** 一个工作区层的全部条目。 */
  listScope(scopeId: string): Promise<MemoryEntry[]> {
    return this.readLayer(join(this.dir, `${this.tokenOf(scopeId)}${LOG_SUFFIX}`));
  }

  /**
   * 提取产出 → 落进工作区层。id / at / 出处 / episodeId 由这里铸（提取侧不造 id，
   * 也不能伪造出处），所以返回值才是真相。
   *
   * **按归一化文本去重**（#228 真机验收的教训：模型复述记忆会把同一事实再蒸一条，
   * 不去重库就单调膨胀），先对本作用域与 user 层都查一遍（user 层将来有手工升上去
   * 的条目，不该因为升层被再写一份）。draft 的 turns 先夹回段内轮号集合（模型幻觉
   * 的轮号不丢整条，但也不能指向段外）。空批不碰盘。
   */
  async appendScope(
    scopeId: string,
    episode: MemoryEpisode,
    drafts: readonly MemoryDraft[],
  ): Promise<MemoryEntry[]> {
    const atOfTurn = new Map(episode.turns.map((turn) => [turn.turn, turn.at]));
    const seen = new Set(
      [...(await this.listScope(scopeId)), ...(await this.listUser())].map((entry) =>
        normalizeText(entry.text),
      ),
    );
    const entries: MemoryEntry[] = [];
    for (const draft of drafts) {
      const text = draft.text.trim();
      if (text === "") continue;
      // 偏好要理由、经验要依据（契约）：解析侧已拦一道，落盘侧兑底——
      // 将来别的生产者（界面手工加条目）也漏不进来
      if (draft.type !== "fact" && (draft.reason?.trim() ?? "") === "") continue;
      const key = normalizeText(text);
      if (seen.has(key)) continue;
      seen.add(key);
      // 出处是这条记忆的承诺：轮号夹回段内集合，模型幻觉的轮号丢弃；
      // 全部轮号都在段外 = 这条的出处对不上，不落盘
      const turns = [...new Set(draft.turns.filter((turn) => atOfTurn.has(turn)))].sort((a, b) => a - b);
      if (turns.length === 0) continue;
      // 时间位置 = 支撑轮里最新的那轮（契约；turns 已夹回段内，atOfTurn 必有）
      const at = Math.max(...turns.map((turn) => atOfTurn.get(turn)!));
      entries.push({
        id: `mem_${randomUUID()}`,
        type: draft.type,
        text,
        ...(draft.reason !== undefined && draft.reason.trim() !== "" ? { reason: draft.reason.trim() } : null),
        keywords: draft.keywords
          .filter((keyword) => typeof keyword === "string" && keyword.trim() !== "")
          .slice(0, KEYWORD_LIMIT),
        layer: "workspace",
        scopeId,
        sessionId: episode.sessionId,
        turns,
        at,
        episodeId: episode.episodeId,
        source: "chat",
        ...(draft.pendingPromote === true ? { pendingPromote: true } : null),
        ...(draft.conflictWith !== undefined ? { conflictWith: draft.conflictWith } : null),
      });
    }
    if (entries.length === 0) return [];
    await mkdir(this.dir, { recursive: true });
    await appendFile(
      join(this.dir, `${this.tokenOf(scopeId)}${LOG_SUFFIX}`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    return entries;
  }

  /** 注入账本追加一行（含零命中——「这轮没注入」也是要能查的账）。 */
  async recordInjection(record: {
    sessionId: string;
    turn: number;
    at: number;
    hits: readonly { id: string; score: number; pinned?: boolean }[];
  }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, "injections.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  }
}
