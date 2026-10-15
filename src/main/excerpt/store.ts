/**
 * 摘抄存储 —— 主进程侧的数据面（IPC 四层的第 2 层身后）。
 *
 *   <userData>/excerpts.jsonl   只追加，一行一个 Excerpt
 *
 * - add：补 id（`exc_` + randomUUID）、createdAt；正文 trim 首尾空白、超上限截断。
 *   **幂等**：同一会话 + 轮 + 角色 + 规整文字（trim + 内部空白折叠）已存在则返回
 *   已有那条、duplicate = true——界面据此说「已经摘过」。
 * - list：全量、坏行跳过（半截行不该拖垮整份清单，session/channel 同款纪律）、
 *   新的在前（只追加 ⇒ 文件尾即最新，倒序即得）。
 * - remove：按 id 过滤后**整体重写**，走 writeTextAtomic（临时文件 + rename，禁裸写）；
 *   id 不在返回 false，不写盘。坏行在重写时顺带清掉——它本来就不是摘抄。
 * - 全部变更走**一条写入链**（读-改-写互相覆盖的问题，UsageLedger / SessionStore
 *   的 queueMeta 同源）：两个一样的 add 并发时，若各自读旧文件再各追加一行，
 *   幂等就失效了。
 * - 会话删除**不级联**（2026-10-15 裁决）：摘抄仍有价值，只是出处会话没了、
 *   sessionTitle 变 null、不可跳转。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接加载（channel/store.ts
 * 同款先例）。
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeTextAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import { EXCERPT_MAX_CHARS, type Excerpt, type ExcerptItem, type ExcerptAddRequest } from "../../shared/excerpt.ts";
import type { QuoteRole } from "../../shared/quote.ts";

/**
 * 正文规整：trim 首尾空白，超上限截断（截断发生在 trim 之后）。trim 后为空是
 * 调用方的 bug（ipc 已挡纯空白入参），这里再抛一次兜底——空摘抄没有任何消费者。
 */
export function normalizeExcerptText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("摘抄正文 trim 后为空");
  // 按**字符**截（Array.from 展开代理对），不从 emoji 中间劈开
  const chars = Array.from(trimmed);
  return chars.length > EXCERPT_MAX_CHARS ? chars.slice(0, EXCERPT_MAX_CHARS).join("") : trimmed;
}

/** 幂等键：会话 + 轮 + 角色 + 规整文字（内部空白折叠成单空格——换行不同不算新摘抄）。 */
function dedupKeyOf(item: { sessionId: string; turn?: number; role: QuoteRole; text: string }): string {
  return JSON.stringify([item.sessionId, item.turn ?? null, item.role, item.text.replace(/\s+/g, " ")]);
}

/** 落在一行里的形状校验：长着 Excerpt 的脸但字段不齐 → null（坏行，跳过）。 */
export function parseExcerptLine(value: unknown): Excerpt | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const text = record["text"];
  const sessionId = record["sessionId"];
  const role = record["role"];
  const createdAt = record["createdAt"];
  const turn = record["turn"];
  if (typeof id !== "string" || !id.startsWith("exc_")) return null;
  if (typeof text !== "string" || text === "") return null;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (role !== "user" && role !== "assistant") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (turn !== undefined && (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1)) return null;
  return {
    id,
    text,
    sessionId,
    ...(turn !== undefined ? { turn } : {}),
    role,
    createdAt,
  };
}

export class ExcerptStore {
  private readonly file: string;
  /** 写入链：add / remove 串行化，防读-改-写互相覆盖 */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async add(request: ExcerptAddRequest): Promise<{ excerpt: Excerpt; duplicate: boolean }> {
    return this.runSerialized(async () => {
      const text = normalizeExcerptText(request.text);
      const existing = await this.readAll();
      const found = existing.find((line) => dedupKeyOf(line) === dedupKeyOf({ ...request, text }));
      if (found !== undefined) return { excerpt: found, duplicate: true };
      const excerpt: Excerpt = {
        id: `exc_${randomUUID()}`,
        text,
        sessionId: request.sessionId,
        ...(request.turn !== undefined ? { turn: request.turn } : {}),
        role: request.role,
        createdAt: Date.now(),
      };
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(excerpt)}\n`, "utf8");
      return { excerpt, duplicate: false };
    });
  }

  /** 全部摘抄，新的在前。只读，不进写入链：rename / append 原子可见，半截行由坏行跳过兜住。 */
  async list(): Promise<Excerpt[]> {
    return (await this.readAll()).reverse();
  }

  async remove(id: string): Promise<boolean> {
    return this.runSerialized(async () => {
      const all = await this.readAll();
      const kept = all.filter((line) => line.id !== id);
      if (kept.length === all.length) return false;
      // 逐行原样序列化（不重排字段），空清单落空文件——文件本身留着，语义是「有过、删完了」
      await writeTextAtomic(this.file, kept.map((line) => JSON.stringify(line)).join("\n") + (kept.length > 0 ? "\n" : ""));
      return true;
    });
  }

  /** 读全量（文件序 = 追加序）。文件不存在 = 还没有摘过（ENOENT → []），其它读错照抛（读不了 ≠ 没有）。 */
  private async readAll(): Promise<Excerpt[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const excerpts: Excerpt[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = parseExcerptLine(JSON.parse(line));
        if (parsed !== null) excerpts.push(parsed);
      } catch {
        // 半截行：跳过它，前面读到的照常返回
      }
    }
    return excerpts;
  }

  private runSerialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** 会话标题源（SessionStore 的结构子集——不硬耦合类，测试可自备夹具，UsageBackfillSource 同款）。 */
export interface ExcerptSessionSource {
  readMeta(id: string): Promise<{ title: string } | null>;
}

/**
 * 为摘抄补出处会话标题：null = 会话已删，界面不可跳转（摘抄本身留着）。
 * 同一会话只读一次——list 一次可能几十条同会话摘抄，回回读盘没有意义。
 */
export async function attachSessionTitles(
  excerpts: Excerpt[],
  sessions: ExcerptSessionSource,
): Promise<ExcerptItem[]> {
  const titles = new Map<string, string | null>();
  for (const excerpt of excerpts) {
    if (titles.has(excerpt.sessionId)) continue;
    titles.set(excerpt.sessionId, (await sessions.readMeta(excerpt.sessionId))?.title ?? null);
  }
  return excerpts.map((excerpt) => ({ excerpt, sessionTitle: titles.get(excerpt.sessionId) ?? null }));
}
