/**
 * 自动化记录文件的「被动过」兜底：指纹、事件文件、冷文件水位。
 *
 * 背景（2026-11-14 独立验收）：命令串闸门（agent/protected-command.ts）是启发式的，拦不住所有写法——
 * 真正密封要靠操作系统级沙箱。但智能体只在应用开着时才会动手，而应用开着时主进程手里有记录的内存真源。
 * 所以这里让「拦不住的也不会无声消失」：
 *
 *   - **TrackedFile**：记住应用自己上次写下的那份（大小 + mtime + 内容哈希）。核对时先比大小与 mtime（一次 stat，
 *     便宜），对不上才读文件比哈希。对不上就是被动过：缺失 / 内容不是我们写的那份。
 *   - **事件文件** `automations-events.jsonl`：只追加，每次发现被动过记一行（何时、哪个文件、发现了什么、做了什么）；
 *     用户点「知道了」追加一行 ack。它也在受保护单文件名单里。
 *   - **冷文件水位**（ColdMark）：冷文件不在内存里，没法「按真源写回」，只能做到「有改动看得出来」——
 *     记大小 + 头 4KB 哈希 + 水位处末尾 4KB 哈希，随热归档文件一起落盘；对不上就留事件并告诉用户，不动它。
 *
 * **为什么是「用到时核对 + 每次调度 tick」而不是 fs.watch**：watch 在各平台的语义不一（macOS FSEvents 会合并、
 * Windows 对 rename 覆盖的事件序不稳），还会把应用自己的原子写（临时文件 + rename）当成改动，得再做一层去噪；
 * 而核对只是两三次 stat，调度器每 30 秒的 tick 本来就要读 store，面板每次重拉也要读，用到的时候一定核对，
 * 延迟最多一个 tick。代价：两次核对之间的一次「删了又换回一模一样的内容」看不出来（也没有损失）。
 */
import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeTextAtomic } from "../atomic-write.ts";
import type { AutomationGuardEvent, AutomationGuardKind } from "../../shared/automation.ts";

const EVENTS_FILE_NAME = "automations-events.jsonl";
const MARK_WINDOW_BYTES = 4096;

export function automationEventsFilePath(dir: string): string {
  return join(dir, EVENTS_FILE_NAME);
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
}

/* ---------- 指纹 ---------- */

export type TrackCheck = { state: "unknown" } | { state: "ok" } | { state: "missing" } | { state: "changed" };

/** 一个受监视的文件：记住应用上次写下的那份，核对时看盘上是不是还是它 */
export class TrackedFile {
  readonly path: string;
  private known = false;
  private size = -1;
  private mtimeMs = -1;
  /** 认可的内容哈希：写成功后是新那份；写失败 / 不确定时新旧两份都认（半成品落盘不算篡改） */
  private hashes = new Set<string>();

  constructor(path: string) {
    this.path = path;
  }

  /** 应用刚把 text 原子写成了这个文件 */
  async wrote(text: string): Promise<void> {
    const info = await stat(this.path);
    this.known = true;
    this.size = info.size;
    this.mtimeMs = info.mtimeMs;
    this.hashes = new Set([sha256(text)]);
  }

  /** 写失败（或不知道落到哪一步）：旧的与想写的都认，下一次核对时按哈希判 */
  acceptAlso(text: string): void {
    this.hashes.add(sha256(text));
    this.size = -1;
  }

  /** 以盘上当前内容为基线（启动对账之后）；盘上没有就不监视 */
  async baseline(): Promise<void> {
    try {
      const [bytes, info] = await Promise.all([readFile(this.path), stat(this.path)]);
      this.known = true;
      this.size = info.size;
      this.mtimeMs = info.mtimeMs;
      this.hashes = new Set([sha256(bytes)]);
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
      this.known = false;
    }
  }

  /** 核对盘上还是不是我们写的那份 */
  async check(): Promise<TrackCheck> {
    if (!this.known) return { state: "unknown" };
    let info;
    try {
      info = await stat(this.path);
    } catch (cause) {
      if (isNotFound(cause)) return { state: "missing" };
      throw cause;
    }
    if (info.size === this.size && info.mtimeMs === this.mtimeMs) return { state: "ok" };
    const hash = sha256(await readFile(this.path));
    if (this.hashes.has(hash)) {
      this.size = info.size;
      this.mtimeMs = info.mtimeMs;
      this.hashes = new Set([hash]);
      return { state: "ok" };
    }
    return { state: "changed" };
  }

  /** 用 text 重写并重新记指纹（自愈用） */
  async rewrite(text: string): Promise<void> {
    try {
      await writeTextAtomic(this.path, text);
    } catch (cause) {
      this.acceptAlso(text);
      throw cause;
    }
    await this.wrote(text);
  }
}

/* ---------- 事件文件 ---------- */

type EventLine = (AutomationGuardEvent & { ack?: undefined }) | { ack: true; at: number };

/** 追加一行事件（fsync）。失败只在终端留一行，不抛——记事件不能把调用方的主流程带崩 */
export async function appendGuardLine(path: string, line: EventLine): Promise<void> {
  try {
    const handle = await open(path, "a");
    try {
      await handle.write(`${JSON.stringify(line)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (cause) {
    console.error("[automation] 写事件文件失败", cause);
  }
}

const KINDS: readonly AutomationGuardKind[] = ["missing", "changed", "coldMissing", "coldChanged", "dataDirReplaced"];

/** 读事件文件里**最后一次 ack 之后**的事件（新→旧）；坏行跳过 */
export async function readUnacknowledged(path: string): Promise<AutomationGuardEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return [];
    console.error("[automation] 读事件文件失败", cause);
    return [];
  }
  let events: AutomationGuardEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value["ack"] === true) {
        events = [];
        continue;
      }
      if (typeof value["at"] === "number" && typeof value["file"] === "string" && KINDS.includes(value["kind"] as AutomationGuardKind)) {
        events.push({
          at: value["at"],
          file: value["file"],
          kind: value["kind"] as AutomationGuardKind,
          ...(typeof value["records"] === "number" ? { records: value["records"] } : {}),
          ...(typeof value["backup"] === "string" ? { backup: value["backup"] } : {}),
        });
      }
    } catch {
      // 半行 / 坏行
    }
  }
  return events.reverse();
}

export function ackLine(at: number): EventLine {
  return { ack: true, at };
}

export function eventLine(event: AutomationGuardEvent): EventLine {
  return event;
}

/* ---------- 冷文件水位 ---------- */

export interface ColdMark {
  /** 应用上次追加完时冷文件的大小 */
  size: number;
  /** 文件头 4KB 的哈希 */
  head: string;
  /** 水位处末尾 4KB（[size-4096, size)）的哈希 */
  tail: string;
}

async function readWindow(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 冷文件当前的水位；文件不存在或是空的返回 null */
export async function coldMarkOf(path: string): Promise<ColdMark | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
  if (size === 0) return null;
  const window = Math.min(size, MARK_WINDOW_BYTES);
  return { size, head: sha256(await readWindow(path, 0, window)), tail: sha256(await readWindow(path, size - window, window)) };
}

/** 对着上次记下的水位核对冷文件：文件还在、没缩小、头与水位处的末尾都对得上。追加（变大）不算问题 */
export async function checkColdMark(path: string, mark: ColdMark): Promise<"ok" | "missing" | "changed"> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (cause) {
    if (isNotFound(cause)) return "missing";
    throw cause;
  }
  if (size < mark.size) return "changed";
  const window = Math.min(mark.size, MARK_WINDOW_BYTES);
  if (sha256(await readWindow(path, 0, window)) !== mark.head) return "changed";
  if (sha256(await readWindow(path, mark.size - window, window)) !== mark.tail) return "changed";
  return "ok";
}

/** 解热归档文件里的 `cold` 字段；坏了当没有 */
export function parseColdMark(raw: unknown): ColdMark | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const size = value["size"];
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  if (typeof value["head"] !== "string" || typeof value["tail"] !== "string") return null;
  return { size: Math.floor(size), head: value["head"], tail: value["tail"] };
}
