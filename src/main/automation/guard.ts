/**
 * 自动化记录文件的「被动过」兜底：指纹、事件日志、冷文件的块哈希。
 *
 * 背景（2026-11-14 独立验收）：命令串闸门（agent/protected-command.ts）是启发式的，拦不住所有写法——
 * 真正密封要靠操作系统级沙箱。但智能体只在应用开着时才会动手，而应用开着时主进程手里有记录的内存真源。
 * 所以这里让「拦不住的也不会无声消失」：
 *
 *   - **TrackedFile**：记住应用自己上次写下的那份（大小 + mtime + **ctime** + inode，加内容哈希）。核对时先 stat（便宜）：
 *     四项都没变就认为没动；对不上才读文件比哈希。改内容再把 mtime 用 utimes 钉回去是最常见的「同尺寸同 mtime」手法，
 *     但 ctime 是内核维护的、用户态改不了（utimes / chmod / rename 都会让它变），所以它被抓得到；再加一条**周期性全哈希**
 *     （默认每 10 秒至多一次）兜底 stat 不可信的文件系统。读失败（EACCES / EPERM，`chmod 000`）单独算一种状态，不再当「没变」。
 *   - **事件日志**（GuardLog）：每次发现被动过记一条带**序号**的事件。落两份：数据目录里的
 *     `automations-events.jsonl`（只追加，fsync），以及数据目录**之外**的镜像（目录被删 / 改名后新目录的事件从镜像补回）。
 *     两份都被 TrackedFile 监视（按内存里的事件重建期望内容）：被删、截断、改写、外部追加都会留 `.tampered-` 副本、
 *     按内存写回、再记一条 `eventsChanged`。「已读」不再是事件文件里的一行 ack，而是独立的、带序号的已读位置
 *     （`automations-ack.json` 与镜像各一份），伪造一行不能清空历史。
 *   - **冷文件的块哈希**（ColdMark）：冷文件不在内存里，没法「按真源写回」，只能做到「有改动看得出来」——
 *     记**精确大小**与每 4 MiB 一块的哈希。大小必须与上次自己追加后的精确大小相等（外部追加、截断一眼看出），
 *     中段等长改写靠块哈希在 stat 变化时与启动后的后台审计里抓到；追加后只重算最后一块，不是每次读整份。
 *   - **指纹镜像**（fingerprints.json，在数据目录之外）：每次写盘前后记下三份记录文件认可的哈希、冷文件水位、数据目录的
 *     inode。应用关着期间有人动过，下次启动对不上就记一条 `changedWhileClosed`（只告知，不恢复，以盘上为准）。
 *
 * **为什么是「用到时核对 + 每次调度 tick」而不是 fs.watch**：watch 在各平台的语义不一（macOS FSEvents 会合并、
 * Windows 对 rename 覆盖的事件序不稳），还会把应用自己的原子写（临时文件 + rename）当成改动，得再做一层去噪；
 * 而核对只是几次 stat，调度器每 30 秒的 tick 本来就要读 store，面板每次重拉也要读，用到的时候一定核对，
 * 延迟最多一个 tick。已知限制：两次核对之间连改两次，只留得下最后一次的 `.tampered-` 副本与一条事件（中间态不可恢复）。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeTextAtomic } from "../atomic-write.ts";
import type { AutomationGuardEvent, AutomationGuardKind } from "../../shared/automation.ts";

const EVENTS_FILE_NAME = "automations-events.jsonl";
const ACK_FILE_NAME = "automations-ack.json";
const FINGERPRINT_FILE_NAME = "fingerprints.json";
/** 冷文件按块哈希的块大小：追加后只重算最后一块（≤ 4 MiB），验证一次整份是一遍顺序读 */
export const COLD_BLOCK_BYTES = 4 * 1024 * 1024;
/** stat 没变也至少隔这么久读一次文件比哈希（毫秒）。stat 在个别文件系统上不可信时的兜底 */
export const FULL_HASH_EVERY_MS = 10_000;
/** 启动时冷文件不超过这个大小就当场整份比块哈希（几毫秒到几十毫秒），超过的交给后台审计，不拖慢启动 */
const STARTUP_FULL_VERIFY_BYTES = 16 * 1024 * 1024;
/** 事件在内存里最多留这么多条（文件不裁剪；超过的最旧事件只留在文件里） */
const EVENTS_KEPT = 5000;
/** `.tampered-` 副本最多留这么多份（再多的删最旧的） */
const TAMPERED_KEPT = 5;

export function automationEventsFilePath(dir: string): string {
  return join(dir, EVENTS_FILE_NAME);
}

export function automationAckFilePath(dir: string): string {
  return join(dir, ACK_FILE_NAME);
}

/** 数据目录之外的镜像目录里的两份文件（事件镜像与已读位置镜像）与指纹文件：受保护名单要拿去拼 */
export function guardMirrorFilePaths(mirrorDir: string): string[] {
  return [join(mirrorDir, EVENTS_FILE_NAME), join(mirrorDir, ACK_FILE_NAME), join(mirrorDir, FINGERPRINT_FILE_NAME)];
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null ? (cause as { code?: string }).code : undefined;
}

function isNotFound(cause: unknown): boolean {
  return errorCode(cause) === "ENOENT";
}

/** 读不了：权限被改（chmod 000）或被占用，或者那个位置被换成了目录。这是一种状态，不是「没变」 */
export function isUnreadable(cause: unknown): boolean {
  const code = errorCode(cause);
  return code === "EACCES" || code === "EPERM" || code === "EISDIR";
}

/* ---------- 指纹 ---------- */

export type TrackCheck = { state: "unknown" } | { state: "ok" } | { state: "missing" } | { state: "changed" } | { state: "unreadable" };

export interface TrackedFileOptions {
  /** stat 没变也至少隔这么久全哈希一次（毫秒；0 = 每次都读） */
  fullHashEveryMs?: number;
}

/** 一个受监视的文件：记住应用上次写下的那份，核对时看盘上是不是还是它 */
export class TrackedFile {
  readonly path: string;
  private readonly fullHashEveryMs: number;
  private known = false;
  private size = -1;
  private mtimeMs = -1;
  private ctimeMs = -1;
  private ino = -1n;
  private hashedAt = 0;
  /** 认可的内容哈希：写成功后是新那份；写失败 / 不确定时新旧两份都认（半成品落盘不算篡改） */
  private hashes = new Set<string>();

  constructor(path: string, options: TrackedFileOptions = {}) {
    this.path = path;
    this.fullHashEveryMs = options.fullHashEveryMs ?? FULL_HASH_EVERY_MS;
  }

  private remember(info: Stats | { size: number; mtimeMs: number; ctimeMs: number; ino: number | bigint }): void {
    this.known = true;
    this.size = info.size;
    this.mtimeMs = info.mtimeMs;
    this.ctimeMs = info.ctimeMs;
    this.ino = BigInt(info.ino);
    this.hashedAt = Date.now();
  }

  /** 认可的哈希（写进指纹镜像，应用关着期间有人动过时下次启动拿来对） */
  acceptedHashes(): string[] {
    return this.known ? [...this.hashes] : [];
  }

  /** 应用刚把 text 原子写成了这个文件 */
  async wrote(text: string): Promise<void> {
    this.remember(await stat(this.path));
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
      const bytes = await readFile(this.path);
      this.remember(await stat(this.path));
      this.hashes = new Set([sha256(bytes)]);
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
      this.known = false;
    }
  }

  /** 核对盘上还是不是我们写的那份 */
  async check(): Promise<TrackCheck> {
    if (!this.known) return { state: "unknown" };
    let info: Stats;
    try {
      info = await stat(this.path);
    } catch (cause) {
      if (isNotFound(cause)) return { state: "missing" };
      if (isUnreadable(cause)) return { state: "unreadable" };
      throw cause;
    }
    const sameStat = info.size === this.size && info.mtimeMs === this.mtimeMs && info.ctimeMs === this.ctimeMs && BigInt(info.ino) === this.ino;
    if (sameStat && Date.now() - this.hashedAt < this.fullHashEveryMs) return { state: "ok" };
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (cause) {
      if (isNotFound(cause)) return { state: "missing" };
      if (isUnreadable(cause)) return { state: "unreadable" };
      // 被换成了目录：读不了它，我们的原子写也会因此失败（调用方会看到报错）——算「读不了」，只告知，不挪走别人放进去的目录
      if (errorCode(cause) === "EISDIR") return { state: "unreadable" };
      throw cause;
    }
    const hash = sha256(bytes);
    if (this.hashes.has(hash)) {
      this.remember(info);
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

/** 被动过的文件留成 `<文件>.tampered-<时间戳>`（给人看，不是备份来源），最多留 TAMPERED_KEPT 份 */
export async function setAsideTampered(path: string, at: number): Promise<string | undefined> {
  const name = `${basename(path)}.tampered-${at}`;
  try {
    await rename(path, join(dirname(path), name));
  } catch (cause) {
    console.error("[automation] 被改的文件留底失败", cause);
    return undefined;
  }
  try {
    const base = basename(path);
    const names = (await readdir(dirname(path))).filter((entry) => entry.startsWith(`${base}.tampered-`)).sort();
    for (const old of names.slice(0, Math.max(0, names.length - TAMPERED_KEPT))) await unlink(join(dirname(path), old)).catch(() => undefined);
  } catch (cause) {
    console.error("[automation] 清理旧的留底失败", cause);
  }
  return name;
}

/* ---------- 事件日志 ---------- */

const KINDS: readonly AutomationGuardKind[] = [
  "missing",
  "changed",
  "unreadable",
  "coldMissing",
  "coldChanged",
  "dataDirReplaced",
  "eventsChanged",
  "ackChanged",
  "changedWhileClosed",
];

/** 解一行事件；坏行 / 不认识的（含旧版留下的 `{ack:true}` 行）返回 null */
export function parseEventLine(line: string): AutomationGuardEvent | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const { seq, at, file, kind } = value;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
    if (typeof at !== "number" || typeof file !== "string" || !KINDS.includes(kind as AutomationGuardKind)) return null;
    return {
      seq,
      at,
      file,
      kind: kind as AutomationGuardKind,
      ...(typeof value["records"] === "number" ? { records: value["records"] } : {}),
      ...(typeof value["archived"] === "number" ? { archived: value["archived"] } : {}),
      ...(typeof value["backup"] === "string" ? { backup: value["backup"] } : {}),
      ...(typeof value["movedTo"] === "string" ? { movedTo: value["movedTo"] } : {}),
    };
  } catch {
    return null;
  }
}

function eventLine(event: AutomationGuardEvent): string {
  return JSON.stringify({
    seq: event.seq,
    at: event.at,
    file: event.file,
    kind: event.kind,
    ...(event.records === undefined ? {} : { records: event.records }),
    ...(event.archived === undefined ? {} : { archived: event.archived }),
    ...(event.backup === undefined ? {} : { backup: event.backup }),
    ...(event.movedTo === undefined ? {} : { movedTo: event.movedTo }),
  });
}

/** 事件文件的期望内容：内存里的事件逐行 */
function serializeEvents(events: readonly AutomationGuardEvent[]): string {
  return events.length === 0 ? "" : `${events.map(eventLine).join("\n")}\n`;
}

/** 读一份事件文件：返回按 seq 升序的事件、有没有「文件里存在但认不得的行」（伪造 / 乱码；末尾没换行的半行是崩溃留的，不算）、文件在不在 */
async function readEventFile(path: string): Promise<{ events: AutomationGuardEvent[]; foreign: boolean; exists: boolean; unreadable: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return { events: [], foreign: false, exists: false, unreadable: false };
    if (isUnreadable(cause)) return { events: [], foreign: false, exists: true, unreadable: true };
    throw cause;
  }
  const lines = text.split("\n");
  // 最后一段要么是空串（正常以换行结尾），要么是崩溃时没写完的半行——都不算内容，也不算被动过
  lines.pop();
  const bySeq = new Map<number, AutomationGuardEvent>();
  let foreign = false;
  let lastSeq = 0;
  for (const line of lines) {
    if (line === "") continue;
    const event = parseEventLine(line);
    if (event === null || event.seq <= lastSeq) {
      foreign = true;
      continue;
    }
    lastSeq = event.seq;
    bySeq.set(event.seq, event);
  }
  return { events: [...bySeq.values()], foreign, exists: true, unreadable: false };
}

async function readAckFile(path: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const seq = value["ackedSeq"];
    return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null;
  } catch {
    return null;
  }
}

/** 已读位置的内容只有序号：同样的位置总是同样的字节（重写、别的实例写都不会被当成「被改过」） */
function ackText(seq: number): string {
  return `${JSON.stringify({ ackedSeq: seq }, null, 2)}\n`;
}

/** 追加一行（fsync）。失败抛出，由调用方决定怎么办 */
async function appendLine(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.write(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 一份「期望内容来自内存」的文件：事件文件、已读位置，数据目录里一份、镜像里一份 */
interface MemoryFile {
  track: TrackedFile;
  /** 事件里记的文件名（镜像的带 "(mirror) " 前缀） */
  label: string;
  kind: "eventsChanged" | "ackChanged";
  text: () => string;
}

export interface GuardLogOptions {
  dir: string;
  /** 数据目录之外的镜像目录；没给就没有镜像（测试） */
  mirrorDir?: string;
  now: () => number;
  fullHashEveryMs?: number;
}

/**
 * 事件日志 + 已读位置：内存是真源，数据目录与镜像各落一份，并且都被监视。
 * 所有方法由 store 在它的写入链里调用，不自己加锁。
 */
export class GuardLog {
  private readonly options: GuardLogOptions;
  private events: AutomationGuardEvent[] = [];
  private lastSeq = 0;
  private ackSeq = 0;
  private readonly dataEvents: TrackedFile;
  private readonly dataAck: TrackedFile;
  private readonly mirrorEvents: TrackedFile | null;
  private readonly mirrorAck: TrackedFile | null;
  private readonly unreadableReported = new Set<string>();

  constructor(options: GuardLogOptions) {
    this.options = options;
    const tracked = (path: string): TrackedFile => new TrackedFile(path, { fullHashEveryMs: options.fullHashEveryMs ?? FULL_HASH_EVERY_MS });
    this.dataEvents = tracked(automationEventsFilePath(options.dir));
    this.dataAck = tracked(automationAckFilePath(options.dir));
    this.mirrorEvents = options.mirrorDir === undefined ? null : tracked(join(options.mirrorDir, EVENTS_FILE_NAME));
    this.mirrorAck = options.mirrorDir === undefined ? null : tracked(join(options.mirrorDir, ACK_FILE_NAME));
  }

  private memoryFiles(): MemoryFile[] {
    const files: MemoryFile[] = [
      { track: this.dataEvents, label: EVENTS_FILE_NAME, kind: "eventsChanged", text: () => serializeEvents(this.events) },
      { track: this.dataAck, label: ACK_FILE_NAME, kind: "ackChanged", text: () => ackText(this.ackSeq) },
    ];
    if (this.mirrorEvents !== null) files.push({ track: this.mirrorEvents, label: `(mirror) ${EVENTS_FILE_NAME}`, kind: "eventsChanged", text: () => serializeEvents(this.events) });
    if (this.mirrorAck !== null) files.push({ track: this.mirrorAck, label: `(mirror) ${ACK_FILE_NAME}`, kind: "ackChanged", text: () => ackText(this.ackSeq) });
    return files;
  }

  /** 还没确认的事件（新→旧） */
  unacknowledged(): AutomationGuardEvent[] {
    return this.events.filter((event) => event.seq > this.ackSeq).reverse();
  }

  all(): readonly AutomationGuardEvent[] {
    return this.events;
  }

  /**
   * 启动时读两份事件文件与两份已读位置，按 seq 取并集：
   * 数据目录里缺的（被删 / 截断 / 目录被换）从镜像补回，镜像里缺的从数据目录补进去；
   * 文件里有认不得的行（伪造 / 乱码）留 `.tampered-` 副本、按并集重写。返回需要补记的事件（由 store 记）。
   */
  async load(): Promise<{ notes: { kind: "eventsChanged"; file: string; backup?: string }[]; unreadable: string[] }> {
    const notes: { kind: "eventsChanged"; file: string; backup?: string }[] = [];
    const unreadable: string[] = [];
    const data = await readEventFile(automationEventsFilePath(this.options.dir));
    const mirror = this.options.mirrorDir === undefined ? null : await readEventFile(join(this.options.mirrorDir, EVENTS_FILE_NAME));
    if (data.unreadable) unreadable.push(EVENTS_FILE_NAME);
    if (mirror?.unreadable === true) unreadable.push(`(mirror) ${EVENTS_FILE_NAME}`);
    const merged = new Map<number, AutomationGuardEvent>();
    for (const event of [...(mirror?.events ?? []), ...data.events]) merged.set(event.seq, event);
    this.events = [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-EVENTS_KEPT);
    this.lastSeq = this.events[this.events.length - 1]?.seq ?? 0;

    const expected = serializeEvents(this.events);
    // 数据目录里的事件文件对不上并集：缺的行是被删 / 截断 / 目录被换（有镜像可补）→ 留副本、写回、记 eventsChanged；
    // 镜像里缺的行多半是崩溃落在「数据目录已追加、镜像未追加」之间，静默补上
    const repair = async (path: string, label: string, parsed: { events: AutomationGuardEvent[]; foreign: boolean; exists: boolean; unreadable: boolean }, isMirror: boolean): Promise<void> => {
      if (parsed.unreadable) return;
      const missingLines = parsed.events.length !== this.events.length;
      const needsRewrite = parsed.exists ? parsed.foreign || missingLines : this.events.length > 0;
      if (!needsRewrite) return;
      const loud = !isMirror || parsed.foreign;
      let backup: string | undefined;
      if (parsed.exists && loud) backup = await setAsideTampered(path, this.options.now());
      await writeTextAtomic(path, expected);
      if (loud && (parsed.exists || !isMirror)) notes.push({ kind: "eventsChanged", file: label, ...(backup === undefined ? {} : { backup }) });
    };
    await repair(automationEventsFilePath(this.options.dir), EVENTS_FILE_NAME, data, false);
    if (this.options.mirrorDir !== undefined && mirror !== null) await repair(join(this.options.mirrorDir, EVENTS_FILE_NAME), `(mirror) ${EVENTS_FILE_NAME}`, mirror, true);

    const dataAck = await readAckFile(automationAckFilePath(this.options.dir));
    const mirrorAck = this.options.mirrorDir === undefined ? null : await readAckFile(join(this.options.mirrorDir, ACK_FILE_NAME));
    const candidates = [dataAck, mirrorAck].filter((value): value is number => value !== null);
    // 两份取小：任何一份被伪造得更大都藏不住事件；数据目录被换掉（只剩镜像）时用镜像的
    this.ackSeq = Math.min(candidates.length === 0 ? 0 : Math.min(...candidates), this.lastSeq);
    for (const file of this.memoryFiles()) {
      if (file.kind === "ackChanged") {
        await writeTextAtomic(file.track.path, file.text()).catch((cause: unknown) => console.error("[automation] 写已读位置失败", cause));
      }
      await file.track.baseline().catch((cause: unknown) => console.error("[automation] 记事件文件指纹失败", cause));
    }
    return { notes, unreadable };
  }

  /** 追加一条事件：分配序号、数据目录与镜像各 fsync 追加一行。写不进去只留日志（记事件不能把主流程带崩） */
  async append(partial: Omit<AutomationGuardEvent, "seq" | "at">): Promise<AutomationGuardEvent> {
    const event: AutomationGuardEvent = { seq: this.lastSeq + 1, at: this.options.now(), ...partial };
    this.lastSeq = event.seq;
    this.events = [...this.events, event].slice(-EVENTS_KEPT);
    const expected = serializeEvents(this.events);
    for (const file of this.memoryFiles()) {
      if (file.kind !== "eventsChanged") continue;
      try {
        await appendLine(file.track.path, `${eventLine(event)}\n`);
        await file.track.wrote(expected);
      } catch (cause) {
        console.error("[automation] 写事件文件失败", cause);
        file.track.acceptAlso(expected);
      }
    }
    return event;
  }

  /** 用户点了「知道了」：已读位置移到 upTo（不给 = 目前最新一条），数据目录与镜像各写一份 */
  async ack(upTo?: number): Promise<void> {
    const target = Math.min(Math.max(upTo ?? this.lastSeq, this.ackSeq), this.lastSeq);
    this.ackSeq = target;
    for (const file of this.memoryFiles()) {
      if (file.kind !== "ackChanged") continue;
      try {
        await file.track.rewrite(file.text());
      } catch (cause) {
        console.error("[automation] 写已读位置失败", cause);
      }
    }
  }

  /** 数据目录被换掉之后：把事件与已读位置从内存写回新目录（不记事件——调用方已经记了 dataDirReplaced） */
  async restoreDataFiles(): Promise<void> {
    for (const file of this.memoryFiles()) {
      if (file.label.startsWith("(mirror)")) continue;
      await file.track.rewrite(file.text()).catch((cause: unknown) => console.error("[automation] 写回事件文件失败", cause));
    }
  }

  /**
   * 核对事件文件与已读位置（数据目录与镜像各一份）：不是内存里该有的样子就留 `.tampered-` 副本、按内存写回、记一条事件；
   * 读不了（chmod 000）记一次 `unreadable`，权限恢复后下一次核对自愈。返回这次发现的事件。
   */
  async verify(): Promise<AutomationGuardEvent[]> {
    const found: AutomationGuardEvent[] = [];
    const pending: { kind: MemoryFile["kind"]; label: string; backup?: string; unreadable?: boolean }[] = [];
    for (const file of this.memoryFiles()) {
      let check: TrackCheck;
      try {
        check = await file.track.check();
      } catch (cause) {
        console.error("[automation] 核对事件文件失败（下次再核对）", cause);
        continue;
      }
      if (check.state === "unreadable") {
        if (!this.unreadableReported.has(file.label)) {
          this.unreadableReported.add(file.label);
          pending.push({ kind: file.kind, label: file.label, unreadable: true });
        }
        continue;
      }
      this.unreadableReported.delete(file.label);
      if (check.state === "ok" || check.state === "unknown") continue;
      let backup: string | undefined;
      if (check.state === "changed") backup = await setAsideTampered(file.track.path, this.options.now());
      try {
        await file.track.rewrite(file.text());
      } catch (cause) {
        console.error("[automation] 写回事件文件失败", cause);
      }
      pending.push({ kind: file.kind, label: file.label, ...(backup === undefined ? {} : { backup }) });
    }
    for (const item of pending) {
      found.push(await this.append(item.unreadable === true ? { file: item.label, kind: "unreadable" } : { file: item.label, kind: item.kind, ...(item.backup === undefined ? {} : { backup: item.backup }) }));
    }
    return found;
  }

  /* ---------- 指纹镜像 ---------- */

  async readFingerprints(): Promise<Fingerprints | null> {
    if (this.options.mirrorDir === undefined) return null;
    try {
      return parseFingerprints(JSON.parse(await readFile(join(this.options.mirrorDir, FINGERPRINT_FILE_NAME), "utf8")));
    } catch {
      return null;
    }
  }

  async writeFingerprints(fingerprints: Fingerprints): Promise<void> {
    if (this.options.mirrorDir === undefined) return;
    await writeTextAtomic(join(this.options.mirrorDir, FINGERPRINT_FILE_NAME), `${JSON.stringify(fingerprints)}\n`);
  }
}

export interface Fingerprints {
  version: 1;
  /** 写下这份指纹时的数据目录路径 */
  dir: string;
  /** 数据目录的 inode（字符串；取不到 null） */
  dirIno: string | null;
  /** 文件名 → 认可的哈希（写盘期间新旧两份都认） */
  files: Record<string, string[]>;
  cold: ColdMark | null;
}

function parseFingerprints(raw: unknown): Fingerprints | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value["version"] !== 1 || typeof value["dir"] !== "string") return null;
  const files: Record<string, string[]> = {};
  const rawFiles = value["files"];
  if (typeof rawFiles === "object" && rawFiles !== null) {
    for (const [name, hashes] of Object.entries(rawFiles as Record<string, unknown>)) {
      if (Array.isArray(hashes) && hashes.every((hash) => typeof hash === "string")) files[name] = hashes as string[];
    }
  }
  return { version: 1, dir: value["dir"], dirIno: typeof value["dirIno"] === "string" ? value["dirIno"] : null, files, cold: parseColdMark(value["cold"]) };
}

/** 数据目录被改名之后，在它的上级目录里找 inode 相同的那个（rename 不换 inode），告诉用户旧目录现在叫什么 */
export async function findMovedDir(dir: string, oldIno: string): Promise<string | undefined> {
  try {
    const parent = dirname(dir);
    for (const name of await readdir(parent)) {
      const candidate = join(parent, name);
      if (candidate === dir) continue;
      const info = await lstat(candidate, { bigint: true }).catch(() => null);
      if (info !== null && info.isDirectory() && String(info.ino) === oldIno) return candidate;
    }
  } catch (cause) {
    console.error("[automation] 找被改名的旧数据目录失败", cause);
  }
  return undefined;
}

/* ---------- 冷文件的块哈希 ---------- */

export interface ColdMark {
  /** 应用上次追加完时冷文件的**精确**大小 */
  size: number;
  /** 每 COLD_BLOCK_BYTES 一块的哈希（sha256 前 32 个十六进制字符），最后一块可能不满 */
  blocks: string[];
}

function blockHash(data: Uint8Array): string {
  return sha256(data).slice(0, 32);
}

/** 顺序读一遍文件，按块哈希。文件不存在返回 null；读不了抛 */
async function hashBlocks(path: string, fromBlock = 0): Promise<{ size: number; blocks: string[] } | null> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
  const blocks: string[] = [];
  const stream = createReadStream(path, { start: fromBlock * COLD_BLOCK_BYTES, highWaterMark: COLD_BLOCK_BYTES });
  for await (const chunk of stream) blocks.push(blockHash(chunk as Buffer));
  return { size: info.size, blocks };
}

/** 冷文件当前的水位（整份顺序读一遍）；文件不存在或是空的返回 null */
export async function coldMarkOf(path: string): Promise<ColdMark | null> {
  const hashed = await hashBlocks(path);
  return hashed === null || hashed.size === 0 ? null : hashed;
}

/**
 * 应用刚往冷文件**追加**之后：旧水位只有最后一块（及新增的块）变了，从那一块起重算，其余沿用。
 * 前提是追加之前已经核对过旧水位（调用方保证）；旧水位为空就整份重算。
 */
export async function extendColdMark(path: string, previous: ColdMark | null): Promise<ColdMark | null> {
  if (previous === null || previous.size === 0) return coldMarkOf(path);
  const firstChanged = Math.floor(previous.size / COLD_BLOCK_BYTES);
  // 旧水位的最后一块满块时，追加从下一块开始；不满块时那一块被改了
  const keep = previous.blocks.slice(0, previous.size % COLD_BLOCK_BYTES === 0 ? previous.blocks.length : firstChanged);
  const tail = await hashBlocks(path, keep.length);
  if (tail === null) return null;
  return { size: tail.size, blocks: [...keep, ...tail.blocks] };
}

export type ColdState = "ok" | "missing" | "changed" | "unreadable";

/**
 * 冷文件的监视：stat 指纹 + 块哈希水位。大小必须等于水位的精确大小（外部追加 / 截断一眼看出）；
 * 大小对但 stat 变了（mtime / ctime / inode）再整份比块哈希；stat 没变就不读（ctime 内核维护，改内容必变）。
 */
export class ColdTracker {
  readonly path: string;
  private statAt: { size: number; mtimeMs: number; ctimeMs: number; ino: bigint } | null = null;

  constructor(path: string) {
    this.path = path;
  }

  private remember(info: Stats): void {
    this.statAt = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: BigInt(info.ino) };
  }

  /** 应用自己刚追加完 / 刚核对过：记下此刻的 stat 作为「没动过」的基线 */
  async trust(): Promise<void> {
    this.remember(await stat(this.path));
  }

  /**
   * 对着水位核对。`full` = 不管 stat 有没有变都整份比块哈希（启动后的后台审计、周期性审计用）。
   * 启动时没有基线 stat：不大的文件（≤ 16 MiB）当场整份比块哈希，更大的只比精确大小、整份比对交给后台审计。
   */
  async check(mark: ColdMark | null, options: { full?: boolean; startup?: boolean } = {}): Promise<ColdState> {
    let info: Stats;
    try {
      info = await stat(this.path);
    } catch (cause) {
      if (isNotFound(cause)) return mark === null ? "ok" : "missing";
      if (isUnreadable(cause)) return "unreadable";
      throw cause;
    }
    if (mark === null) return "ok";
    if (info.size !== mark.size) return "changed";
    if (options.startup === true && options.full !== true && info.size > STARTUP_FULL_VERIFY_BYTES) {
      this.remember(info);
      return "ok";
    }
    const before = this.statAt;
    const sameStat =
      before !== null && before.size === info.size && before.mtimeMs === info.mtimeMs && before.ctimeMs === info.ctimeMs && before.ino === BigInt(info.ino);
    if (sameStat && options.full !== true) return "ok";
    let hashed: { size: number; blocks: string[] } | null;
    try {
      hashed = await hashBlocks(this.path);
    } catch (cause) {
      if (isUnreadable(cause)) return "unreadable";
      throw cause;
    }
    if (hashed === null) return "missing";
    if (hashed.size !== mark.size || hashed.blocks.length !== mark.blocks.length || hashed.blocks.some((hash, index) => hash !== mark.blocks[index])) return "changed";
    this.remember(info);
    return "ok";
  }
}

/** 解热归档 / 指纹文件里的 `cold` 字段；坏了（或是旧版的头尾哈希格式）当没有，后台审计会重新记 */
export function parseColdMark(raw: unknown): ColdMark | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const size = value["size"];
  const blocks = value["blocks"];
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  if (!Array.isArray(blocks) || blocks.length === 0 || !blocks.every((block) => typeof block === "string")) return null;
  return { size: Math.floor(size), blocks: blocks as string[] };
}
