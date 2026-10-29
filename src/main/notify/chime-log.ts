/**
 * 提示音账本 —— 主进程侧的数据面（IPC 四层的第 2 层身后）。
 *
 *   <userData>/chime-log.jsonl   只追加，一行一声（ChimeLogEntry）
 *
 * 用途见 shared/notify.ts：事后对证「那一声是谁」。没有读接口——读它的是人
 * （打开文件看），不是界面；没有第二个消费者之前不建 list。
 *
 * - 入参不可信：normalizeChimeLog 只放行已知 reason、字符串 id/title，标题截断、
 *   人数封顶——renderer 传什么都不能让这本账无限长一行。
 * - **封顶**：文件过了 CHIME_LOG_MAX_BYTES 就只留后一半的行（原子重写，临时文件 +
 *   rename），提示音一天响几百声也不会把磁盘吃满；留下的永远是最近的。
 * - 所有写走一条串行链（ExcerptStore 同款）：两声同时到时，裁剪的读-改-写不会
 *   吞掉另一声的追加。
 *
 * **纯模块**：不 import electron，`node --test` 直接加载。
 */
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { writeTextAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import type { ChimeLogEntry, ChimeLogRequest, ChimeReason, ChimeSubject } from "../../shared/notify.ts";

/** 文件上限：256 KB ≈ 两千来声，够回看好几天 */
export const CHIME_LOG_MAX_BYTES = 256 * 1024;
/** 一声最多记几个人（同拍落定的根会话数，实际 1–3） */
export const CHIME_SUBJECTS_MAX = 20;
/** 标题截断字数：对照用，不需要全文 */
export const CHIME_TITLE_MAX = 120;

const REASONS: readonly ChimeReason[] = ["session-settled", "focus-done"];

function subjectOf(value: unknown): ChimeSubject | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, title } = value as { id?: unknown; title?: unknown };
  if (typeof id !== "string" || id === "") return null;
  const text = typeof title === "string" ? title : "";
  const chars = Array.from(text);
  return { id, title: chars.length > CHIME_TITLE_MAX ? chars.slice(0, CHIME_TITLE_MAX).join("") : text };
}

/** 合法 → 净化后的请求；不合法 → null（ipc 直接 return，不记）。坏的 subject 单条丢弃。 */
export function normalizeChimeLog(raw: unknown): ChimeLogRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { reason, subjects } = raw as { reason?: unknown; subjects?: unknown };
  if (typeof reason !== "string" || !REASONS.includes(reason as ChimeReason)) return null;
  const list = Array.isArray(subjects) ? subjects : [];
  return {
    reason: reason as ChimeReason,
    subjects: list
      .slice(0, CHIME_SUBJECTS_MAX)
      .map(subjectOf)
      .filter((subject): subject is ChimeSubject => subject !== null),
  };
}

export class ChimeLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(file: string, maxBytes: number = CHIME_LOG_MAX_BYTES) {
    this.file = file;
    this.maxBytes = maxBytes;
  }

  /** 记一声。时刻由这里打（renderer 的钟不进账）；写失败照抛，由调用方决定吞不吞。 */
  append(request: ChimeLogRequest, now: Date = new Date()): Promise<void> {
    const entry: ChimeLogEntry = { at: now.toISOString(), ...request };
    const line = `${JSON.stringify(entry)}\n`;
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true });
      await this.trimIfFull();
      await appendFile(this.file, line, "utf8");
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** 过了上限只留后一半的行（按行切，不留半行） */
  private async trimIfFull(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (size <= this.maxBytes) return;
    const lines = (await readFile(this.file, "utf8")).split("\n").filter((line) => line !== "");
    const kept = lines.slice(Math.floor(lines.length / 2));
    await writeTextAtomic(this.file, kept.length === 0 ? "" : `${kept.join("\n")}\n`);
  }
}
