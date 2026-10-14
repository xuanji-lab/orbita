/**
 * 会话记忆落盘——**每个作用域一个只追加的 JSONL**：
 *
 *   <userData>/memory/<sha1(scopeId)>.jsonl   一行一条 MemoryEntry
 *
 * 为什么按作用域分文件（而不是全局一份、每行带 scopeId）：召回永远只问一个作用域
 * （一次开轮只属于一个工作区），分文件让「读这个作用域的记忆」就是读一个小文件，
 * 不必全量扫再过滤。语料本来就小（一条会话几条），线性扫描的代价可以忽略。
 *
 * 文件名用 sha1 而不是原样 scopeId：workspaceId 是 uuid 还好，cwd 是任意绝对路径
 * （盘符、冒号、反斜杠、超长深度），原样当文件名在 Windows 上就是一堆非法字符。
 * 哈希之后文件名恒合法且定长；代价是「token ↔ scopeId」单向——**管理面（设置 ›
 * 记忆库）按 token 寻址**（MemoryScopeToken），scopeId 只活在 agent 侧那条
 * 「主进程按会话归属解析」的路上。全局作用域（MEMORY_GLOBAL_SCOPE）同规则。
 *
 * 写入口径与 SessionStore / ChannelStore 一致：**只追加**（appendFile，一行一条），
 * 读全量、坏行跳过；单次追加写由 O_APPEND 保证不撕裂（同 SessionStore.record 的约定）。
 * 例外是**改写**（删 / 改 / 移 / 拍板冲突）——按定义就是改文件，走 `atomic-write.ts`
 * 的临时文件 + rename（「整份换掉」的语义），半路被杀时盘上不会留下缺行的中间态。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测（session/store.ts 同款先例）。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MemoryConflictResolution,
  MemoryDraft,
  MemoryEntry,
  MemoryEntryOrigin,
  MemoryScopeToken,
  MemorySource,
  MemoryStance,
  MemoryStatus,
} from "../../shared/memory.ts";
import { writeTextAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";

/** 契约说关键词 ≤8 个（shared/memory.ts）。超了截断——多给的关键词只会把打分稀释。 */
const KEYWORD_LIMIT = 8;

const LOG_SUFFIX = ".jsonl";

/**
 * 作用域 id：**会话归属的工作区优先，没有工作区才退回 cwd**（契约定稿，
 * `workspaceId ?? cwd`）。纯函数放这里而不是塞进 IPC 胶水——「哪两条会话共享记忆」
 * 是存储策略，值得单独测。
 */
export function memoryScopeOf(meta: { workspaceId: string | null; cwd: string }): string {
  return meta.workspaceId ?? meta.cwd;
}

/* ---------- v2 扩展字段的宽松解读（旧行缺字段 = 默认值，不迁移文件） ---------- */

const SOURCES: readonly MemorySource[] = ["distilled", "excerpt", "manual"];
const STATUSES: readonly MemoryStatus[] = ["active", "superseded", "muted"];
const STANCES: readonly MemoryStance[] = ["position", "agree", "doubt", "oppose"];
const RESOLUTIONS: readonly MemoryConflictResolution[] = ["replace", "keep-both", "drop-new"];

/** 枚举字段的宽松解读：值在表里就收，不在（含类型不对）当缺席——一条坏字段不值得丢整条记忆。 */
function enumOf<T extends string>(value: unknown, table: readonly T[]): T | undefined {
  return typeof value === "string" && (table as readonly string[]).includes(value) ? (value as T) : undefined;
}

function originOf(value: unknown): MemoryEntryOrigin | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const suspect = value as { verbatim?: unknown; turn?: unknown; role?: unknown };
  if (typeof suspect.verbatim !== "string" || suspect.verbatim === "") return undefined;
  if (typeof suspect.turn !== "number" || !Number.isInteger(suspect.turn) || suspect.turn < 1) return undefined;
  if (suspect.role !== "user" && suspect.role !== "assistant") return undefined;
  return { verbatim: suspect.verbatim, turn: suspect.turn, role: suspect.role };
}

/**
 * 逐字段校验一行 JSONL；字段不齐返回 null。**长着条目的脸但不齐的行跳过**——
 * 半截条目注入 prompt，比少一条更难查（session/store.ts 的 readLogEntries 同一条纪律）。
 * v2 扩展字段全部宽松：缺席 / 类型不对 / 枚举不认识都当默认（distilled + active），
 * 旧文件不迁移也照常工作。
 *
 * 放在 main 侧而不是 shared/memory.ts：契约文件已定稿，解析是落盘侧的实现细节。
 */
export function parseMemoryEntry(value: unknown): MemoryEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const suspect = value as {
    id?: unknown;
    text?: unknown;
    keywords?: unknown;
    sessionId?: unknown;
    timestamp?: unknown;
    source?: unknown;
    status?: unknown;
    pinned?: unknown;
    stance?: unknown;
    origin?: unknown;
    turn?: unknown;
    editedAt?: unknown;
    supersedes?: unknown;
    supersededBy?: unknown;
    conflictResolution?: unknown;
  };
  if (typeof suspect.id !== "string" || suspect.id === "") return null;
  if (typeof suspect.text !== "string" || suspect.text === "") return null;
  // sessionId 允许空串：手动添加（设置 › 记忆库）没有来源会话；蒸馏 / 摘抄恒非空
  if (typeof suspect.sessionId !== "string") return null;
  if (typeof suspect.timestamp !== "number" || !Number.isFinite(suspect.timestamp)) return null;
  if (!Array.isArray(suspect.keywords)) return null;
  const keywords: string[] = [];
  for (const keyword of suspect.keywords) {
    if (typeof keyword !== "string") return null;
    keywords.push(keyword);
  }
  const source = enumOf(suspect.source, SOURCES);
  const status = enumOf(suspect.status, STATUSES);
  const stance = enumOf(suspect.stance, STANCES);
  const resolution = enumOf(suspect.conflictResolution, RESOLUTIONS);
  const turn =
    typeof suspect.turn === "number" && Number.isInteger(suspect.turn) && suspect.turn >= 1
      ? suspect.turn
      : undefined;
  return {
    id: suspect.id,
    text: suspect.text,
    keywords,
    sessionId: suspect.sessionId,
    timestamp: suspect.timestamp,
    ...(source !== undefined ? { source } : null),
    ...(status !== undefined ? { status } : null),
    ...(suspect.pinned === true ? { pinned: true } : null),
    ...(stance !== undefined ? { stance } : null),
    ...(suspect.editedAt !== undefined && suspect.editedAt !== null
      ? { editedAt: suspect.editedAt as number }
      : null),
    ...(turn !== undefined ? { turn } : null),
    ...(typeof suspect.supersedes === "string" && suspect.supersedes !== ""
      ? { supersedes: suspect.supersedes }
      : null),
    ...(typeof suspect.supersededBy === "string" && suspect.supersededBy !== ""
      ? { supersededBy: suspect.supersededBy }
      : null),
    ...(resolution !== undefined ? { conflictResolution: resolution } : null),
    ...(suspect.origin !== undefined ? { origin: originOf(suspect.origin) } : null),
  };
}

/**
 * draft → 落盘条目。**id 与 sessionId 由这里补**（契约：蒸馏侧不造 id、也不能伪造来源），
 * 所以返回值才是完整条目，调用方拿它当真相。turn / supersedes 同样在这里盖章——
 * supersedes 只在候选表里才收（applyMemoryAppend 验过再传进来），store 不再查。
 *
 * 返回 null = 这条 draft 不值得落盘（当前只有「文本空」一种）。跨进程进来的数据，
 * 清洗放在边界上：模型偶发产出空串 / 空白关键词时，落一条空条目只会白占召回预算。
 */
function toEntry(draft: MemoryDraft, sessionId: string, turn: number): MemoryEntry | null {
  const text = draft.text.trim();
  if (text === "") return null;
  const keywords: string[] = [];
  for (const keyword of draft.keywords) {
    if (typeof keyword !== "string") continue;
    const trimmed = keyword.trim();
    if (trimmed === "") continue;
    keywords.push(trimmed);
    if (keywords.length >= KEYWORD_LIMIT) break;
  }
  return {
    id: `mem_${randomUUID()}`,
    text,
    keywords,
    sessionId,
    timestamp: draft.timestamp,
    source: "distilled",
    turn,
    ...(draft.supersedes !== undefined ? { supersedes: draft.supersedes } : null),
  };
}

export class MemoryStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** scopeId → 盘上 token（sha1 hex）。管理面按 token 寻址，这是两条路的换算点。 */
  tokenOf(scopeId: string): MemoryScopeToken {
    return createHash("sha1").update(scopeId).digest("hex");
  }

  /** 作用域的文件路径（排障与测试用；生产代码不拿它绕过 append / list）。 */
  filePath(scopeId: string): string {
    return this.pathOfToken(this.tokenOf(scopeId));
  }

  private pathOfToken(token: MemoryScopeToken): string {
    return join(this.dir, `${token}${LOG_SUFFIX}`);
  }

  /**
   * 全部条目，落盘顺序。文件不存在 = 一条都没有；**读不了 ≠ 没有**（权限等照抛，
   * 同 CarryoverStore 的纪律）。坏行跳过不抛。
   */
  async list(token: MemoryScopeToken): Promise<MemoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.pathOfToken(token), "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    return parseLines(raw);
  }

  /**
   * 盘上有哪些作用域（带条目数）。**只有装着条目的文件算作用域**——删空的文件
   * 还躺在盘上，把它列出来是一个点不进去的空页。读不了单个文件不算全局失败：
   * 那个作用域缺席，别的照常列（管理面是浏览面，单文件坏了不该挡住整页）。
   */
  async scopes(): Promise<{ token: MemoryScopeToken; count: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const found: { token: MemoryScopeToken; count: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(LOG_SUFFIX)) continue;
      const token = name.slice(0, -LOG_SUFFIX.length);
      const entries = await this.list(token).catch(() => []);
      if (entries.length > 0) found.push({ token, count: entries.length });
    }
    return found;
  }

  /**
   * 落一批 draft：补 id / sessionId / turn 后逐行追加。返回铸好的完整条目（落盘顺序）。
   *
   * **按归一化文本去重**（真机验收观察：模型在回答里复述记忆，轮后蒸馏会把同一
   * 事实再蒸一条——不去重库就单调膨胀）。只挡逐字级重复（trim + 空白折叠），
   * 近似重复不挡——那需要相似度计算，等语料长大再评（ponytail）。
   * 读-改-写有理论竞态（同工作区两条会话同时收尾），漏网的代价只是一条重复，可接受。
   *
   * 空批不碰盘——调用方（轮后蒸馏）产出 0 条是常态，不该为此建目录。
   */
  async append(
    token: MemoryScopeToken,
    sessionId: string,
    turn: number,
    drafts: readonly MemoryDraft[],
  ): Promise<MemoryEntry[]> {
    const seen = new Set((await this.list(token)).map((entry) => normalizeText(entry.text)));
    const entries: MemoryEntry[] = [];
    for (const draft of drafts) {
      const entry = toEntry(draft, sessionId, turn);
      if (entry === null) continue;
      const key = normalizeText(entry.text);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    if (entries.length === 0) return [];
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.pathOfToken(token), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    return entries;
  }

  /**
   * 添加摘抄：逐字原文即正文、常驻、带出处。同一句摘两次**幂等**——返回已在库里的
   * 那条（去重口径与蒸馏一致：归一化文本）。不自动找冲突——摘抄是用户亲眼挑的话，
   * 不拿去和蒸馏条目对撞。
   */
  async addExcerpt(
    token: MemoryScopeToken,
    sessionId: string,
    excerpt: { verbatim: string; role: "user" | "assistant"; turn: number; stance: MemoryStance },
  ): Promise<MemoryEntry> {
    const existing = await this.list(token);
    const key = normalizeText(excerpt.verbatim);
    const found = existing.find((entry) => normalizeText(entry.text) === key);
    if (found !== undefined) return found;
    const entry: MemoryEntry = {
      id: `mem_${randomUUID()}`,
      text: excerpt.verbatim,
      keywords: [],
      sessionId,
      timestamp: Date.now(),
      source: "excerpt",
      pinned: true,
      stance: excerpt.stance,
      origin: { verbatim: excerpt.verbatim, turn: excerpt.turn, role: excerpt.role },
      turn: excerpt.turn,
    };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.pathOfToken(token), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /** 手动添加（设置 › 记忆库）：用户自己写的一条，常驻、算「我说的 · 立场」。 */
  async addManual(token: MemoryScopeToken, text: string): Promise<MemoryEntry | null> {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const entry: MemoryEntry = {
      id: `mem_${randomUUID()}`,
      text: trimmed,
      keywords: [],
      sessionId: "",
      timestamp: Date.now(),
      source: "manual",
      pinned: true,
      stance: "position",
    };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.pathOfToken(token), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /**
   * 原地改一条（编辑 / 常驻开关 / 状态）。返回改后的条目；null = 这个 id 不在
   * （幂等，与 remove 同一口径）。改正文会盖 editedAt；开关字段只在请求里给了才动。
   */
  async patch(
    token: MemoryScopeToken,
    entryId: string,
    patch: { text?: string; pinned?: boolean; status?: MemoryStatus; stance?: MemoryStance },
  ): Promise<MemoryEntry | null> {
    let updated: MemoryEntry | null = null;
    const kept = await this.mapEntries(token, (entry) => {
      if (entry.id !== entryId) return entry;
      const text = patch.text !== undefined ? patch.text.trim() : entry.text;
      const next: MemoryEntry = {
        ...entry,
        text: text === "" ? entry.text : text,
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : null),
        ...(patch.status !== undefined ? { status: patch.status } : null),
        ...(patch.stance !== undefined ? { stance: patch.stance } : null),
        ...(patch.text !== undefined && text !== "" ? { editedAt: Date.now() } : null),
      };
      updated = next;
      return next;
    });
    if (updated === null) return null;
    await this.writeAll(token, kept);
    return updated;
  }

  /**
   * 删一条：读全量 → 滤掉这个 id → **整份换掉**（writeTextAtomic，临时文件 + rename）。
   *
   * JSONL 没有索引，删中间一行只能重写整个文件；用 rename 而不是裸写，是为了让
   * 「写到一半被杀」表现为旧的完整文件或新的完整文件，而不是一条缺行的记忆库——
   * 召回侧读到缺行的库不会报错，只会安静地少几条（最难查的那类）。
   *
   * 返回 false = 这个 id 本来就不在（**文件不存在也是这条路径**），不抛：设置页的
   * 「删除」要幂等，用户连点两下，第二次该安静地什么也不发生。空 id 串同样 false——
   * 它不是「删掉了什么」，是调用方没给对。
   * **读不了 ≠ 没有**：list 抛出来的（权限坏了、盘上那个路径是个目录）照抛，
   * 不冒充「删掉了」。
   * 删空之后留空文件、不删文件：append 不在乎原来空不空（它自己会建目录），
   * 多一条「删空就删文件」的分支只会给下一次 append 添一个没必要的边角。
   */
  async remove(token: MemoryScopeToken, entryId: string): Promise<boolean> {
    if (entryId === "") return false;
    const existing = await this.list(token);
    const kept = existing.filter((entry) => entry.id !== entryId);
    if (kept.length === existing.length) return false;
    await this.writeAll(token, kept);
    return true;
  }

  /** 批量删（记忆库多选）。逐条幂等，返回实际删掉的条数。 */
  async removeBatch(token: MemoryScopeToken, entryIds: readonly string[]): Promise<number> {
    const wanted = new Set(entryIds);
    const existing = await this.list(token);
    const kept = existing.filter((entry) => !wanted.has(entry.id));
    if (kept.length === existing.length) return 0;
    await this.writeAll(token, kept);
    return existing.length - kept.length;
  }

  /**
   * 移到全局：先追加进目标文件、再从源文件改写掉——半路被杀最坏是同一条在两个
   * 作用域各一份（召回时按 id 去重兜住），不会丢条目。同 token 内移动没有意义，
   * 直接 0。id 保留不变：注入记录与「用过几次」按 id 对账，换了 id 就断账。
   */
  async move(fromToken: MemoryScopeToken, destToken: MemoryScopeToken, entryIds: readonly string[]): Promise<number> {
    if (fromToken === destToken) return 0;
    const wanted = new Set(entryIds);
    const existing = await this.list(fromToken);
    const moved = existing.filter((entry) => wanted.has(entry.id));
    if (moved.length === 0) return 0;
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.pathOfToken(destToken), `${moved.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    await this.writeAll(fromToken, existing.filter((entry) => !wanted.has(entry.id)));
    return moved.length;
  }

  /**
   * 冲突拍板（或撤销）。新条目按 token 作用域找；旧条目可能在同作用域，也可能在
   * 全局（跨作用域的冲突建议一样成立）——两处都找。**不动 supersedes 字段本身**：
   * 它是「蒸馏时判过什么」的历史，拍板结果记在 conflictResolution / supersededBy 上，
   * 撤销 = 把这两个翻回去（drop-new 的撤销不支持：新条目已删，无处翻回）。
   *
   * resolved = false 表示没拍成（新旧任一条不在——多半已被处理过，幂等）。
   */
  async resolveConflict(
    token: MemoryScopeToken,
    globalToken: MemoryScopeToken,
    ids: { newId: string; oldId: string },
    resolution: MemoryConflictResolution,
    undo: boolean,
  ): Promise<boolean> {
    const local = await this.list(token);
    const globalEntries = token === globalToken ? [] : await this.list(globalToken);
    const fresh = [...local, ...globalEntries].find((entry) => entry.id === ids.newId);
    const old = [...local, ...globalEntries].find((entry) => entry.id === ids.oldId);
    if (fresh === undefined || old === undefined) return false;

    // 条目所在的作用域文件（新旧可能不同文件：跨作用域冲突）。就地换一条 + 改写。
    const replaceIn = async (entry: MemoryEntry, next: MemoryEntry): Promise<void> => {
      for (const [entries, entryToken] of [
        [local, token],
        [globalEntries, globalToken],
      ] as const) {
        const at = entries.indexOf(entry);
        if (at < 0) continue;
        entries.splice(at, 1, next);
        await this.writeAll(entryToken, entries);
        return;
      }
    };

    if (undo) {
      // drop-new 没有撤销：新条目已删，无处翻回（UI 不给那个键）
      if (resolution === "drop-new") return false;
      if (resolution === "replace") {
        if (old.status !== "superseded") return false;
        const { supersededBy: _by, ...restoredOld } = old;
        await replaceIn(old, { ...restoredOld, status: "active" });
      }
      const { conflictResolution: _cr, ...freshRestored } = fresh;
      await replaceIn(fresh, freshRestored);
      return true;
    }

    if (resolution === "drop-new") {
      // 新条目只在它自己的作用域里（冲突建议总是落在蒸馏的那个作用域）
      const at = local.indexOf(fresh);
      if (at < 0) return false;
      local.splice(at, 1);
      await this.writeAll(token, local);
      return true;
    }
    if (resolution === "replace") {
      await replaceIn(old, { ...old, status: "superseded", supersededBy: fresh.id });
      await replaceIn(fresh, { ...fresh, conflictResolution: "replace" });
      return true;
    }
    await replaceIn(fresh, { ...fresh, conflictResolution: "keep-both" });
    return true;
  }

  /** 读全量 → 逐条变换 → 原子改写。变换不改条数（增删走各自的专用路径）。 */
  private async mapEntries(
    token: MemoryScopeToken,
    map: (entry: MemoryEntry) => MemoryEntry,
  ): Promise<MemoryEntry[]> {
    const existing = await this.list(token);
    return existing.map(map);
  }

  private async writeAll(token: MemoryScopeToken, entries: readonly MemoryEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeTextAtomic(this.pathOfToken(token), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
}

function parseLines(raw: string): MemoryEntry[] {
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

/** 去重键：trim + 内部空白折叠。逐字重复才归并，措辞有差的就是另一条记忆。 */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
