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
 * 写入口径与 SessionStore 一致：新条目**只追加**（appendFile 一行一条，O_APPEND 保证
 * 单次追加不撕裂），读全量、坏行跳过；改已有条目（状态、正文、搬层）走整层原子重写
 * （writeLayer：临时文件 + rename）。
 *
 * 旧实验（#228 时代）留下的 `<sha1>.jsonl` 行缺 type / layer，解析按坏行跳过，
 * 不迁移——那是没合进 main 的实验数据。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
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
import { writeTextAtomic } from "../main/atomic-write.ts";
import type { MemoryInjectionRecord } from "../shared/memory.ts";

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
  /** 跨工作区通用的偏好（只对 preference 生效）：appendScope 直接落 user 层 */
  crossWorkspace?: boolean;
  /** 与旧偏好矛盾（id 已在候选表里验过）：appendScope 把旧条标 stale */
  conflictWith?: string;
}

/** 契约说关键词 ≤8 个（shared/memory.ts）。超了截断——多给的关键词只会把打分稀释。 */
const KEYWORD_LIMIT = 8;

const USER_LAYER_FILE = "user.jsonl";
const USER_TOKEN = "user";
const LOG_SUFFIX = ".jsonl";
/** 旧「待你确认」数据落定过的标记文件（settleLegacyDecisions 只跑一次） */
const LEGACY_MARKER = "legacy-decisions-settled.json";

/* ---------- 行解析：字段不齐的行跳过，宽松字段缺席按默认解读 ---------- */

const TYPES: readonly MemoryEntryType[] = ["fact", "preference", "insight"];
const SOURCES: readonly MemorySource[] = ["chat", "manual", "agent"];
const STATUSES: readonly MemoryStatus[] = ["active", "muted", "stale"];

function enumOf<T extends string>(value: unknown, table: readonly T[]): T | undefined {
  return typeof value === "string" && (table as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * 逐字段校验一行 JSONL；必填字段不齐返回 null。**长着条目的脸但不齐的行跳过**——
 * 半截条目注入 prompt 比少一条更难查（session/store.ts 的同一条纪律）。
 * 可选字段（reason / status / conflictWith …）缺席 / 类型不对都当缺席，一条坏的
 * 可选字段不值得丢整条记忆。旧数据里的拍板字段（pendingPromote / promoteResolution /
 * conflictResolution）不再解析——启动时 settleLegacyDecisions 按新规则落定过一次。
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
    mutedReason?: unknown;
    promotedFrom?: unknown;
    conflictWith?: unknown;
    editedAt?: unknown;
  };
  if (typeof suspect.id !== "string" || suspect.id === "") return null;
  if (typeof suspect.text !== "string" || suspect.text === "") return null;
  if (typeof suspect.sessionId !== "string") return null;
  if (typeof suspect.at !== "number" || !Number.isFinite(suspect.at)) return null;
  if (typeof suspect.episodeId !== "string") return null;
  if (!Array.isArray(suspect.keywords)) return null;
  if (!Array.isArray(suspect.turns)) return null;
  const type = enumOf(suspect.type, TYPES);
  if (type === undefined) return null;
  const layer = enumOf(suspect.layer, ["user", "workspace"] as const satisfies readonly MemoryLayer[]);
  if (layer === undefined) return null;
  const source = enumOf(suspect.source, SOURCES) ?? "chat";
  const status = enumOf(suspect.status, STATUSES);
  // 出处三件套（sessionId / turns / episodeId）与 workspace 层的 scopeId是对话
  // 整理条目的承诺；manual 手动添加没有事件段，全空合法。旧实验数据缺 source
  // 按 chat 解读（严校），新写的 manual 行 source 显式在。
  const withProvenance = source === "chat";
  if (withProvenance && suspect.sessionId === "") return null;
  if (withProvenance && suspect.turns.length === 0) return null;
  if (withProvenance && suspect.episodeId === "") return null;
  if (withProvenance && layer === "workspace" && (typeof suspect.scopeId !== "string" || suspect.scopeId === "")) {
    return null;
  }
  // agent 修订的条目：出处是那条会话那一轮（没有事件段）
  if (source === "agent" && (suspect.sessionId === "" || suspect.turns.length === 0)) return null;
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
    // scopeId 任何层都保留：升到 user 层的条目带着它（撤销升层搬回时它还得在，
    // sha1 单向反解不回来）；只做非空字符串校验，语义校验在 withProvenance 分支
    ...(typeof suspect.scopeId === "string" && suspect.scopeId !== ""
      ? { scopeId: suspect.scopeId }
      : null),
    sessionId: suspect.sessionId,
    turns: [...new Set(turns)].sort((a, b) => a - b),
    at: suspect.at,
    episodeId: suspect.episodeId,
    source,
    ...(typeof suspect.reason === "string" && suspect.reason.trim() !== "" ? { reason: suspect.reason } : null),
    ...(status !== undefined ? { status } : null),
    ...(typeof suspect.mutedReason === "string" && suspect.mutedReason.trim() !== ""
      ? { mutedReason: suspect.mutedReason }
      : null),
    ...(typeof suspect.promotedFrom === "string" && suspect.promotedFrom !== ""
      ? { promotedFrom: suspect.promotedFrom }
      : null),
    ...(typeof suspect.conflictWith === "string" && suspect.conflictWith !== ""
      ? { conflictWith: suspect.conflictWith }
      : null),
    ...(typeof suspect.editedAt === "number" && Number.isFinite(suspect.editedAt)
      ? { editedAt: suspect.editedAt }
      : null),
  };
}

/** 去重键：trim + 内部空白折叠。逐字重复才归并，措辞有差的就是另一条记忆。 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** scopeId → 盘上 token（sha1 hex，定长且恒合法）。模块级函数：主进程的读面 /
 * 写转发也要算它（addManual 补 scopeId 时反向匹配工作区表），不该为此建 store。 */
export function tokenOfScope(scopeId: string): string {
  return createHash("sha1").update(scopeId).digest("hex");
}

export class MemoryEntryStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** scopeId → 盘上文件名（sha1 hex，定长且恒合法）。 */
  tokenOf(scopeId: string): string {
    return tokenOfScope(scopeId);
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
   * 提取产出 → 落盘，**并按 agent 的判断直接落定**（2026-10-29 用户裁决：不要待确认）：
   * - 默认落进工作区层；
   * - crossWorkspace 的偏好直接落 user 层，promotedFrom 记原作用域 token（条目卡的
   *   「只留在原工作区」按它搬回）；
   * - conflictWith 指的旧条（本作用域或 user 层）标 stale——新说法顶掉旧说法，
   *   演变链沿 conflictWith 串起来，「恢复旧说法」可撤。
   * id / at / 出处 / episodeId 由这里铸（提取侧不造 id，也不能伪造出处），所以返回值
   * 才是真相。调用方须同时持有本作用域与 user 层两把锁（两层都可能被写）。
   *
   * **按归一化文本去重**（#228 真机验收的教训：模型复述记忆会把同一事实再蒸一条，
   * 不去重库就单调膨胀），本作用域与 user 层都查一遍。draft 的 turns 先夹回段内
   * 轮号集合（模型幻觉的轮号不丢整条，但也不能指向段外）。空批不碰盘。
   */
  async appendScope(
    scopeId: string,
    episode: MemoryEpisode,
    drafts: readonly MemoryDraft[],
  ): Promise<MemoryEntry[]> {
    const atOfTurn = new Map(episode.turns.map((turn) => [turn.turn, turn.at]));
    const token = this.tokenOf(scopeId);
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
      const promote = draft.type === "preference" && draft.crossWorkspace === true;
      entries.push({
        id: `mem_${randomUUID()}`,
        type: draft.type,
        text,
        ...(draft.reason !== undefined && draft.reason.trim() !== "" ? { reason: draft.reason.trim() } : null),
        keywords: draft.keywords
          .filter((keyword) => typeof keyword === "string" && keyword.trim() !== "")
          .slice(0, KEYWORD_LIMIT),
        layer: promote ? "user" : "workspace",
        scopeId,
        sessionId: episode.sessionId,
        turns,
        at,
        episodeId: episode.episodeId,
        source: "chat",
        ...(promote ? { promotedFrom: token } : null),
        ...(draft.conflictWith !== undefined ? { conflictWith: draft.conflictWith } : null),
      });
    }
    if (entries.length === 0) return [];
    await mkdir(this.dir, { recursive: true });
    const scoped = entries.filter((entry) => entry.layer === "workspace");
    const promoted = entries.filter((entry) => entry.layer === "user");
    if (scoped.length > 0) await this.appendLines(token, scoped);
    if (promoted.length > 0) await this.appendLines(USER_TOKEN, promoted);
    // 新条先落盘、再标旧条 stale：半路被杀最多新旧都 active（召回多一条），不会
    // 出现旧条过时、新条没落的空窗
    const conflicted = new Set(
      entries.flatMap((entry) => (entry.conflictWith === undefined ? [] : [entry.conflictWith])),
    );
    if (conflicted.size > 0) await this.markStale([token, USER_TOKEN], conflicted);
    return entries;
  }

  /**
   * agent 按用户纠正写下新说法（memory_revise）：新条落在旧条同一层，source = agent，
   * 出处是那条会话那一轮，conflictWith 指旧条；随后旧条标 stale。关键词沿用旧条的
   * （同一件事，词法召回的主信号不该因为改了说法就丢）。调用方持有该层的锁。
   * 返回 [新条, 旧条（已 stale）]；旧条不在这一层返回 null。
   */
  async appendRevision(
    token: string,
    oldId: string,
    input: { text: string; reason: string; sessionId: string; turn: number; now: number },
  ): Promise<[MemoryEntry, MemoryEntry] | null> {
    const old = (await this.listByToken(token)).find((entry) => entry.id === oldId);
    if (old === undefined) return null;
    const reason = input.reason.trim();
    const fresh: MemoryEntry = {
      id: `mem_${randomUUID()}`,
      type: old.type,
      text: input.text.trim(),
      ...(reason !== "" ? { reason } : null),
      keywords: old.keywords,
      layer: old.layer,
      ...(old.scopeId !== undefined ? { scopeId: old.scopeId } : null),
      sessionId: input.sessionId,
      turns: [input.turn],
      at: input.now,
      episodeId: "",
      source: "agent",
      ...(old.promotedFrom !== undefined ? { promotedFrom: old.promotedFrom } : null),
      conflictWith: old.id,
    };
    await mkdir(this.dir, { recursive: true });
    await this.appendLines(token, [fresh]);
    const staled = await this.updateEntry(token, old.id, (entry) => ({ ...entry, status: "stale" }));
    return [fresh, staled ?? { ...old, status: "stale" }];
  }

  /** 几层里按 id 把条目标 stale（已不是 active 的不动——muted 的旧条不该被改判成过时）。 */
  private async markStale(tokens: readonly string[], ids: ReadonlySet<string>): Promise<void> {
    for (const token of tokens) {
      const existing = await this.listByToken(token);
      let touched = false;
      const next = existing.map((entry) => {
        if (!ids.has(entry.id) || (entry.status ?? "active") !== "active") return entry;
        touched = true;
        return { ...entry, status: "stale" as const };
      });
      if (touched) await this.writeLayer(token, next);
    }
  }

  private async appendLines(token: string, entries: readonly MemoryEntry[]): Promise<void> {
    await appendFile(
      join(this.dir, `${token}${LOG_SUFFIX}`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }

  /**
   * 旧数据里还没拍板的「待你确认」按新规则落定一次（2026-10-29 晚去掉待确认之前，
   * 提取把跨工作区偏好标 pendingPromote、把冲突标 conflictWith 但不改旧条，等用户拍板）：
   * - pendingPromote 且没拍板 → 搬进 user 层，promotedFrom 记原 token（同 appendScope）；
   * - conflictWith 且没有 conflictResolution、新条还 active → 旧条标 stale。
   * 已拍板过的照它们当时的结果留着（keep-both 的两条都 active，不重判）。
   * **只跑一次**：做完落一个标记文件——新规则下的条目也带 conflictWith，再扫一遍会把
   * 用户「恢复旧说法」后又恢复使用的新条重新顶回去。返回落定了几条（日志用）。
   */
  async settleLegacyDecisions(): Promise<{ promoted: number; staled: number }> {
    const marker = join(this.dir, LEGACY_MARKER);
    try {
      await readFile(marker, "utf8");
      return { promoted: 0, staled: 0 };
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
    let promoted = 0;
    let staled = 0;
    const layers = await this.listLayers();
    const staleIds = new Set<string>();
    for (const layer of layers) {
      const raw = await this.readRawLayer(layer.token);
      for (const row of raw) {
        if (row.status !== undefined && row.status !== "active") continue;
        if (typeof row.conflictWith === "string" && row.conflictResolution === undefined) {
          staleIds.add(row.conflictWith);
        }
        if (
          layer.token !== USER_TOKEN &&
          row.pendingPromote === true &&
          row.promoteResolution === undefined &&
          typeof row.id === "string"
        ) {
          const moved = await this.moveEntry(layer.token, USER_TOKEN, row.id, (entry) => ({
            ...entry,
            layer: "user",
            promotedFrom: layer.token,
          }));
          if (moved !== null) promoted += 1;
        }
      }
    }
    if (staleIds.size > 0) {
      const before = await this.countStatus(staleIds, "stale");
      await this.markStale((await this.listLayers()).map((layer) => layer.token), staleIds);
      staled = (await this.countStatus(staleIds, "stale")) - before;
    }
    // 空库也落标记：之后新规则写出的数据不该再被这一遍扫到
    await mkdir(this.dir, { recursive: true });
    await writeTextAtomic(marker, `${JSON.stringify({ settledAt: Date.now(), promoted, staled })}\n`);
    return { promoted, staled };
  }

  private async countStatus(ids: ReadonlySet<string>, status: MemoryStatus): Promise<number> {
    let count = 0;
    for (const layer of await this.listLayers()) {
      for (const entry of await this.listByToken(layer.token)) {
        if (ids.has(entry.id) && entry.status === status) count += 1;
      }
    }
    return count;
  }

  /** 读一层的原始 JSON 行（只给一次性的旧数据落定用：要看已不再解析的旧字段）。 */
  private async readRawLayer(token: string): Promise<Record<string, unknown>[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, `${token}${LOG_SUFFIX}`), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const rows: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null) rows.push(parsed as Record<string, unknown>);
      } catch {
        // 半截行：跳过
      }
    }
    return rows;
  }

  /** 注入账本追加一行（含零命中——「这轮没注入」也是要能查的账）。 */
  async recordInjection(record: {
    sessionId: string;
    turn: number;
    at: number;
    hits: readonly { id: string; score: number; pinned?: boolean; text?: string }[];
  }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, "injections.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  }

  /**
   * 注入账本全量（按落账顺序；主进程的记忆库读面用，服务自己不读）。坏行跳过、
   * 文件不存在 = 空。
   */
  async listInjections(): Promise<MemoryInjectionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, "injections.jsonl"), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const records: MemoryInjectionRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as MemoryInjectionRecord;
        if (typeof parsed?.sessionId !== "string") continue;
        if (typeof parsed?.turn !== "number" || !Array.isArray(parsed?.hits)) continue;
        records.push(parsed);
      } catch {
        // 半截行：跳过
      }
    }
    return records;
  }

  /** 盘上有哪些条目层（token + 条数；injections 不是层，不列）。只有装着条目的
   * 文件算一层——删空的文件还躺在盘上，列出来是一个点不进去的空页。 */
  async listLayers(): Promise<{ token: string; count: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const found: { token: string; count: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(LOG_SUFFIX) || name === "injections.jsonl") continue;
      const token = name.slice(0, -LOG_SUFFIX.length);
      const entries = await this.readLayer(join(this.dir, name)).catch(() => []);
      if (entries.length > 0) found.push({ token, count: entries.length });
    }
    return found;
  }

  /* ---------- 记忆库写操作的改写路径（整份换掉，临时文件 + rename） ---------- */

  /** 按层文件路径读（listLayers 的内部用，token 已是文件名）。 */
  listByToken(token: string): Promise<MemoryEntry[]> {
    return this.readLayer(join(this.dir, `${token}${LOG_SUFFIX}`));
  }

  /** 整层原子重写（改写路径的唯一落盘点；调用方保证条目已变换好）。 */
  async writeLayer(token: string, entries: readonly MemoryEntry[]): Promise<void> {
    await writeTextAtomic(
      join(this.dir, `${token}${LOG_SUFFIX}`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }

  /** 原地改一条（读全量 → 变换 → 整层重写）。apply 只改数据不改条数；返回改后
   * 的条目；null = 这个 id 不在这一层（幂等，remove 同一口径）。 */
  async updateEntry(
    token: string,
    entryId: string,
    apply: (entry: MemoryEntry) => MemoryEntry,
  ): Promise<MemoryEntry | null> {
    const existing = await this.listByToken(token);
    const at = existing.findIndex((entry) => entry.id === entryId);
    if (at < 0) return null;
    const next = apply(existing[at]!);
    existing.splice(at, 1, next);
    await this.writeLayer(token, existing);
    return next;
  }

  /** 删一条（读全量 → 滤掉 → 重写）。返回被删的条目；不在返回 null（幂等）。 */
  async removeEntry(token: string, entryId: string): Promise<MemoryEntry | null> {
    const existing = await this.listByToken(token);
    const removed = existing.find((entry) => entry.id === entryId) ?? null;
    if (removed === null) return null;
    await this.writeLayer(
      token,
      existing.filter((entry) => entry.id !== entryId),
    );
    return removed;
  }

  /**
   * 搬一条到另一层（升层 / 撤销升层）：先读源层、变换并追加目标层，再删源层。
   * 半路被杀最多短暂同存两份（召回按 id 去重），不会出现两边都没有的丢条窗口。
   * **不做去重**——条目是搬家不是新建，文本重复不该让搬家静默丢条。
   * 返回搬后的条目；源层里没有返回 null。
   */
  async moveEntry(
    fromToken: string,
    toToken: string,
    entryId: string,
    apply: (entry: MemoryEntry) => MemoryEntry,
  ): Promise<MemoryEntry | null> {
    const source = await this.listByToken(fromToken);
    const moved = source.find((entry) => entry.id === entryId) ?? null;
    if (moved === null) return null;
    const next = apply(moved);
    await mkdir(this.dir, { recursive: true });
    await appendFile(
      join(this.dir, `${toToken}${LOG_SUFFIX}`),
      `${JSON.stringify(next)}\n`,
      "utf8",
    );
    await this.removeEntry(fromToken, entryId);
    return next;
  }

  /**
   * 手动添加（记忆库「手动添加」钮）：落在指定层，source = manual、无出处
   * （sessionId / turns / episodeId 为空）。偏好 / 经验必须带 reason（同提取
   * 侧的契约：落盘侧兑底）。scopeId 由调用方带（主进程能从工作区表解出来；
   * Home 作用域解不出就省略——寻址靠 token，scopeId 只是展示参考）。
   * 返回铸好的完整条目；正文空 / 缺 reason 返回 null。
   */
  async addManual(
    token: string,
    input: { type: MemoryEntryType; text: string; reason?: string; scopeId?: string; now: number },
  ): Promise<MemoryEntry | null> {
    const text = input.text.trim();
    if (text === "") return null;
    const reason = input.reason?.trim() ?? "";
    if (input.type !== "fact" && reason === "") return null;
    const layer: MemoryLayer = token === "user" ? "user" : "workspace";
    const entry: MemoryEntry = {
      id: `mem_${randomUUID()}`,
      type: input.type,
      text,
      ...(reason !== "" ? { reason } : null),
      keywords: [],
      layer,
      ...(layer === "workspace" && input.scopeId !== undefined ? { scopeId: input.scopeId } : null),
      sessionId: "",
      turns: [],
      at: input.now,
      episodeId: "",
      source: "manual",
    };
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${token}${LOG_SUFFIX}`), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }
}
