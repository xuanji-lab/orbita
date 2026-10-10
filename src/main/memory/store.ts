/**
 * 会话记忆落盘（memory v1）——**每个作用域一个只追加的 JSONL**：
 *
 *   <userData>/memory/<sha1(scopeId)>.jsonl   一行一条 MemoryEntry
 *
 * 为什么按作用域分文件（而不是全局一份、每行带 scopeId）：召回永远只问一个作用域
 * （一次开轮只属于一个工作区），分文件让「读这个作用域的记忆」就是读一个小文件，
 * 不必全量扫再过滤。语料本来就小（一条会话几条），线性扫描的代价可以忽略。
 *
 * 文件名用 sha1 而不是原样 scopeId：workspaceId 是 uuid 还好，cwd 是任意绝对路径
 * （盘符、冒号、反斜杠、超长深度），原样当文件名在 Windows 上就是一堆非法字符。
 * 哈希之后文件名恒合法且定长；代价是「打开目录看不出哪个文件是哪个作用域」——
 * 排障用 `filePath(scopeId)` 现算，日志里打的就是它。
 *
 * 写入口径与 SessionStore / ChannelStore 一致：**只追加**（appendFile，一行一条），
 * 读全量、坏行跳过。`atomic-write.ts` 的临时文件 + rename 在这里用不上——rename 是
 * 「整份换掉」的语义，而记忆只增不改；单次追加写由 O_APPEND 保证不撕裂
 * （同 SessionStore.record 的约定）。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测（session/store.ts 同款先例）。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryDraft, MemoryEntry } from "../../shared/memory.ts";
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

/**
 * 逐字段校验一行 JSONL；字段不齐返回 null。**长着条目的脸但不齐的行跳过**——
 * 半截条目注入 prompt，比少一条更难查（session/store.ts 的 readLogEntries 同一条纪律）。
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
  };
  if (typeof suspect.id !== "string" || suspect.id === "") return null;
  if (typeof suspect.text !== "string" || suspect.text === "") return null;
  if (typeof suspect.sessionId !== "string" || suspect.sessionId === "") return null;
  if (typeof suspect.timestamp !== "number" || !Number.isFinite(suspect.timestamp)) return null;
  if (!Array.isArray(suspect.keywords)) return null;
  const keywords: string[] = [];
  for (const keyword of suspect.keywords) {
    if (typeof keyword !== "string") return null;
    keywords.push(keyword);
  }
  return {
    id: suspect.id,
    text: suspect.text,
    keywords,
    sessionId: suspect.sessionId,
    timestamp: suspect.timestamp,
  };
}

/**
 * draft → 落盘条目。**id 与 sessionId 由这里补**（契约：蒸馏侧不造 id、也不能伪造来源），
 * 所以返回值才是完整条目，调用方拿它当真相。
 *
 * 返回 null = 这条 draft 不值得落盘（当前只有「文本空」一种）。跨进程进来的数据，
 * 清洗放在边界上：模型偶发产出空串 / 空白关键词时，落一条空条目只会白占召回预算。
 */
function toEntry(draft: MemoryDraft, sessionId: string): MemoryEntry | null {
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
  return { id: `mem_${randomUUID()}`, text, keywords, sessionId, timestamp: draft.timestamp };
}

export class MemoryStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 作用域的文件路径（排障与测试用；生产代码不拿它绕过 append / list）。 */
  filePath(scopeId: string): string {
    return join(this.dir, `${createHash("sha1").update(scopeId).digest("hex")}${LOG_SUFFIX}`);
  }

  /**
   * 全部条目，落盘顺序。文件不存在 = 一条都没有；**读不了 ≠ 没有**（权限等照抛，
   * 同 CarryoverStore 的纪律）。坏行跳过不抛。
   */
  async list(scopeId: string): Promise<MemoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(scopeId), "utf8");
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

  /**
   * 落一批 draft：补 id / sessionId 后逐行追加。返回铸好的完整条目（落盘顺序）。
   *
   * 空批不碰盘——调用方（轮后蒸馏）产出 0 条是常态，不该为此建目录。
   */
  async append(scopeId: string, sessionId: string, drafts: readonly MemoryDraft[]): Promise<MemoryEntry[]> {
    const entries = drafts
      .map((draft) => toEntry(draft, sessionId))
      .filter((entry): entry is MemoryEntry => entry !== null);
    if (entries.length === 0) return [];
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.filePath(scopeId), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    return entries;
  }
}
