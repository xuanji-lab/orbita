/**
 * 自动化的落盘：userData 下三份文件。
 *
 * - `automations.json`：**没结束的**（active / paused / failed），条数受 AUTOMATION_MAX_UNFINISHED 约束，
 *   调度器每 30 秒的 tick 只看它；
 * - `automations-archive.json`：**已结束的**（completed）热归档，最新结束的在前，最多留 AUTOMATION_ARCHIVE_KEEP 条。
 *   归档不进 tick、不占名额，只被面板与 `automation_list`（要求时）读；文件里另记 `older`：冷文件里有多少条；
 * - `automations-archive-old.jsonl`：**冷归档**，热归档放不下的最旧记录**从热文件移除之前先追加到这里**
 *   （一行一条完整记录，只追加，fsync 后才继续；启动与调度都不读它，只在要追加时读尾部做去重）。
 *   不无痕丢记录（2026-11-14 用户原意是「不占名额」，不是「过期销毁」）。
 *   分两份而不是同一份文件里分两段：调度每跑一次都整份重写 `automations.json`，归档放进去会让每次写盘都背着 200 条旧记录。
 *
 * - **全量常驻内存**：自动化是用户手建的少量对象，整份读进来比逐条读盘简单，也让 tick 不碰磁盘。
 * - **写入串行 + 原子写**：所有变更排进同一条链，每次整份经 `writeJsonAtomic`（临时文件 + rename）
 *   落盘；写失败时内存不变（先写盘、成功后才换缓存），调用方拿到抛错。
 * - **归档由 store 自己判**：任何一次写入之后，status 变成 completed 的记录移进归档，被「重新启动」的移回来；
 *   调用方（调度器、取消、会话被删）不用各自知道归档的存在。
 * - **跨两份文件的移动没有「两边都没有」的窗口**：先写**接收方**、后写**交出方**，中途崩溃最坏是两边各有一份；
 *   下次读盘时按 updatedAt 定胜负（移动时给移过去的那份 updatedAt 严格加大；平手算归档赢——宁可不复活已结束的）。
 * - **老数据平滑**：升级前 `automations.json` 里已经是 completed 的，第一次读盘就走同一套（移进归档、先写归档后写主文件）。
 * - **坏文件不吞用户的数据**：整份 JSON 解析失败 → 原文件改名为 `<文件>.bad-<时间戳>` 留给人看，
 *   再从空开始；单条解析失败（字段残缺）只丢那一条。两种都在 dev 终端留一行原因。
 */
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  AUTOMATION_ARCHIVE_KEEP,
  isFinished,
  parseAutomation,
  type Automation,
  type AutomationArchiveInfo,
  type AutomationGuardEvent,
  type AutomationGuardKind,
} from "../../shared/automation.ts";
import { writeJsonAtomic } from "../atomic-write.ts";
import {
  TrackedFile,
  ackLine,
  appendGuardLine,
  automationEventsFilePath,
  checkColdMark,
  coldMarkOf,
  parseColdMark,
  readUnacknowledged,
  type ColdMark,
} from "./guard.ts";

const FILE_NAME = "automations.json";
const ARCHIVE_FILE_NAME = "automations-archive.json";
const COLD_FILE_NAME = "automations-archive-old.jsonl";
/** 追加冷文件前读它尾部做去重：崩溃重试时上一次已追加的那几条在末尾，不用读整份 */
const COLD_TAIL_BYTES = 4 * 1024 * 1024;
const FILE_VERSION = 1;

/**
 * 两份文件的完整路径。真源一份，两个消费者：store 自己用，主进程拿去拼
 * 工具禁区的单文件清单（protectedFiles，2026-11-13 自动化记录不可变）。名字写在
 * 两处的话，改道改名时禁区会静默漏护。
 */
export function automationStoreFilePath(dir: string): string {
  return join(dir, FILE_NAME);
}

export function automationArchiveFilePath(dir: string): string {
  return join(dir, ARCHIVE_FILE_NAME);
}

export function automationColdFilePath(dir: string): string {
  return join(dir, COLD_FILE_NAME);
}

/** 冷文件的文件名（面板与 agent 的 list 告诉用户「更早的 N 条保存在哪」） */
export const AUTOMATION_COLD_FILE_NAME = COLD_FILE_NAME;

/** 工具禁区的单文件清单：四份记录（含事件文件）都不许智能体的 write / edit / bash 碰（连同它们的 `.tmp` / `.bad-` / `.tampered-` 兄弟，匹配在 agent/permission.ts） */
export function automationProtectedFiles(dir: string): string[] {
  return [automationStoreFilePath(dir), automationArchiveFilePath(dir), automationColdFilePath(dir), automationEventsFilePath(dir)];
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
}

/** 读一份文件成列表（+ 热归档文件里的 `older` 计数）：不存在 = 空；坏 JSON 改名留底后从空开始；单条残缺只丢那一条；读不了（权限等）照抛 */
async function readAutomationFile(filePath: string, now: () => number): Promise<{ list: Automation[]; older: number; cold: ColdMark | null }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return { list: [], older: 0, cold: null };
    // 读不了 ≠ 没有：权限等问题照抛，别吞成空列表再被下一次写盘覆盖
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const aside = `${filePath}.bad-${now()}`;
    console.error(`[automation] ${filePath} 不是合法 JSON，已改名为 ${aside} 并从空开始`, cause);
    await rename(filePath, aside).catch((renameCause: unknown) => {
      console.error("[automation] 坏文件改名失败", renameCause);
    });
    return { list: [], older: 0, cold: null };
  }
  const items = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["automations"] : undefined;
  const list: Automation[] = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      const automation = parseAutomation(item);
      if (automation === null) console.error("[automation] 跳过一条字段残缺的自动化", JSON.stringify(item)?.slice(0, 200));
      else if (!list.some((existing) => existing.id === automation.id)) list.push(automation);
    }
  }
  const olderRaw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["older"] : undefined;
  const older = typeof olderRaw === "number" && Number.isFinite(olderRaw) && olderRaw > 0 ? Math.floor(olderRaw) : 0;
  const cold = typeof parsed === "object" && parsed !== null ? parseColdMark((parsed as Record<string, unknown>)["cold"]) : null;
  return { list, older, cold };
}

/** 冷文件尾部已有的记录键（`id@updatedAt`）与「末尾是否缺换行」（上次追加被打断留下半行时，先补一个换行再追加，免得两条粘成一行） */
async function readColdTail(filePath: string): Promise<{ keys: Set<string>; needsNewline: boolean }> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (cause) {
    if (isNotFound(cause)) return { keys: new Set(), needsNewline: false };
    throw cause;
  }
  if (size === 0) return { keys: new Set(), needsNewline: false };
  const length = Math.min(size, COLD_TAIL_BYTES);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // 读的不是从文件头开始：第一段可能是半行，丢掉
    if (length < size) lines.shift();
    const keys = new Set<string>();
    for (const line of lines) {
      if (line === "") continue;
      try {
        const record = JSON.parse(line) as { id?: unknown; updatedAt?: unknown };
        if (typeof record.id === "string" && typeof record.updatedAt === "number") keys.add(`${record.id}@${record.updatedAt}`);
      } catch {
        // 半行 / 坏行：不参与去重
      }
    }
    return { keys, needsNewline: !text.endsWith("\n") };
  } finally {
    await handle.close();
  }
}

/**
 * 扫一遍冷文件，收集每行的键（`id@updatedAt`）。不用 JSON.parse：每行是 JSON.stringify(记录)，
 * `id` 是第一个字段、`updatedAt` 是最后一个字段，两个正则就够，几万行也只是流式过一遍。
 * 只在崩溃后的对账与后台对账里用；平时 older 靠增量。
 */
export async function scanColdKeys(filePath: string): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    await stat(filePath);
  } catch (cause) {
    if (isNotFound(cause)) return keys;
    throw cause;
  }
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    const id = /^\{"id":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
    const updatedAt = /"updatedAt":(\d+)\}$/.exec(line)?.[1];
    if (id !== undefined && updatedAt !== undefined) {
      keys.add(`${id}@${updatedAt}`);
      continue;
    }
    // 字段顺序不是契约：id 不在最前或 updatedAt 不在最后时退回整行解析
    try {
      const record = JSON.parse(line) as { id?: unknown; updatedAt?: unknown };
      if (typeof record.id === "string" && typeof record.updatedAt === "number") keys.add(`${record.id}@${record.updatedAt}`);
    } catch {
      // 半行 / 坏行不算
    }
  }
  return keys;
}

async function countCold(filePath: string): Promise<number> {
  return (await scanColdKeys(filePath)).size;
}

/**
 * 把被挤出热归档的记录追加进冷文件，**落盘（fsync）后才返回**——调用方此后才会把它们从热文件里拿掉。
 * 崩溃重试时同一批已经在尾部的（按 id + updatedAt）不再重复追加。
 */
async function appendCold(filePath: string, records: readonly Automation[]): Promise<void> {
  if (records.length === 0) return;
  const tail = await readColdTail(filePath);
  const fresh = records.filter((record) => !tail.keys.has(`${record.id}@${record.updatedAt}`));
  if (fresh.length === 0) return;
  const handle = await open(filePath, "a");
  try {
    await handle.write(`${tail.needsNewline ? "\n" : ""}${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 内存里的两份：live = 没结束的，archive = 已结束的（最新结束的在前） */
interface Snapshot {
  live: readonly Automation[];
  archive: readonly Automation[];
  /** 冷文件里有多少条（只在追加时增加；热归档文件里持久化，不为了数数去读冷文件） */
  older: number;
  /** 冷文件的水位：应用上次追加完时的大小与头尾哈希；对不上 = 冷文件被动过 */
  cold: ColdMark | null;
}

/**
 * 读盘后的对账：两份里同一 id 出现两次（移动到一半崩溃的残影）按 updatedAt 定胜负；
 * live 里已经是 completed 的（升级前的老数据 / 崩溃残影）移进归档；归档按条数上限截断。
 */
export function reconcileSnapshot(live: readonly Automation[], archive: readonly Automation[]): { live: Automation[]; archive: Automation[] } {
  const archiveById = new Map(archive.map((automation) => [automation.id, automation]));
  const keepLive: Automation[] = [];
  const migrating: Automation[] = [];
  const dropFromArchive = new Set<string>();
  for (const automation of live) {
    const twin = archiveById.get(automation.id);
    if (twin !== undefined) {
      if (automation.updatedAt > twin.updatedAt) {
        // 活的那份更新：是「重新启动」写到一半崩了——归档里的旧份作废；若它自己也是 completed 就让它顶替归档里的
        dropFromArchive.add(automation.id);
        if (isFinished(automation)) migrating.push(automation);
        else keepLive.push(automation);
      }
      // 否则归档那份赢（含平手）：是「归档」写到一半崩了，live 里的是结束前的旧份，丢掉
    } else if (isFinished(automation)) {
      migrating.push(automation);
    } else {
      keepLive.push(automation);
    }
  }
  const keptArchive = archive.filter((automation) => !dropFromArchive.has(automation.id));
  migrating.sort((a, b) => b.updatedAt - a.updatedAt);
  // 老数据迁进来的与归档里原有的并存时按 updatedAt 重排（只迁不并存时，归档原有顺序不动）
  const merged = migrating.length > 0 && keptArchive.length > 0 ? [...migrating, ...keptArchive].sort((a, b) => b.updatedAt - a.updatedAt) : [...migrating, ...keptArchive];
  return { live: keepLive, archive: merged };
}

/** 热归档只留最新结束的 AUTOMATION_ARCHIVE_KEEP 条；挤出去的（最旧的）交给调用方先追加进冷文件再移除 */
export function trimArchive<T>(archive: readonly T[]): { kept: T[]; evicted: T[] } {
  return { kept: archive.slice(0, AUTOMATION_ARCHIVE_KEEP), evicted: archive.slice(AUTOMATION_ARCHIVE_KEEP) };
}

/** store 的可选挂钩：主进程拿它在发现被动过时通知 renderer 重拉（告警随 archiveInfo 带出） */
export interface AutomationStoreHooks {
  onGuardEvent?: () => void;
}

/** 被动过的文件留成 `<文件>.tampered-<时间戳>`，最多留这么多份（再多的删最旧的），免得被反复改动时撑满目录 */
const TAMPERED_BACKUPS_KEPT = 5;

export class AutomationStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly archivePath: string;
  private readonly coldPath: string;
  private readonly eventsPath: string;
  private readonly liveTrack: TrackedFile;
  private readonly archiveTrack: TrackedFile;
  private snapshot: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;
  /** 读盘对账后写盘失败的：内存已经是对的，磁盘还没跟上；下一次成功的写入顺带补上 */
  private stale = { live: false, archive: false };
  /** 写入链：所有变更串行，任何一步失败不卡死后面的 */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly hooks: AutomationStoreHooks;
  /** 数据目录的 inode：变了 = 目录被改名 / 删除后又重建过（只在 posix 上有意义，Windows 上取不到稳定值就不比） */
  private dirIno: bigint | null = null;
  /** 还没被用户点「知道了」的篡改事件，新→旧 */
  private alerts: AutomationGuardEvent[] = [];

  constructor(dir: string, now: () => number = Date.now, hooks: AutomationStoreHooks = {}) {
    this.dir = dir;
    this.filePath = automationStoreFilePath(dir);
    this.archivePath = automationArchiveFilePath(dir);
    this.coldPath = automationColdFilePath(dir);
    this.eventsPath = automationEventsFilePath(dir);
    this.liveTrack = new TrackedFile(this.filePath);
    this.archiveTrack = new TrackedFile(this.archivePath);
    this.now = now;
    this.hooks = hooks;
  }

  private load(): Promise<Snapshot> {
    if (this.snapshot !== null) return Promise.resolve(this.snapshot);
    this.loading ??= this.readAndReconcile();
    return this.loading;
  }

  private async readAndReconcile(): Promise<Snapshot> {
    const liveFile = await readAutomationFile(this.filePath, this.now);
    const archiveFile = await readAutomationFile(this.archivePath, this.now);
    const full = reconcileSnapshot(liveFile.list, archiveFile.list);
    let olderBase = archiveFile.older;
    let cold = archiveFile.cold;
    // 启动时先核对冷文件水位：上次关应用后它被动过 = 留事件、告诉用户，水位以当前文件为准重新记
    if (cold !== null) {
      const state = await checkColdMark(this.coldPath, cold).catch(() => "ok" as const);
      if (state !== "ok") {
        await this.recordEvent(state === "missing" ? "coldMissing" : "coldChanged", AUTOMATION_COLD_FILE_NAME, {});
        cold = await coldMarkOf(this.coldPath).catch(() => null);
      }
    }
    // 从主文件迁来的 completed 里，若冷文件里已经有（上一次迁移在「追加冷文件之后、写主文件之前」被打断过）：
    // 它们早已安全保存在冷文件里，不能再回热归档（会把更新的记录挤出去、冷文件里重复）。丢掉它们，
    // 并按冷文件重数 older（那次打断时热归档文件可能没来得及记上）
    const fromLive = full.archive.filter((record) => liveFile.list.includes(record));
    if (fromLive.length > 0) {
      try {
        const keys = await scanColdKeys(this.coldPath);
        const already = new Set(fromLive.filter((record) => keys.has(`${record.id}@${record.updatedAt}`)));
        if (already.size > 0) {
          full.archive = full.archive.filter((record) => !already.has(record));
          olderBase = keys.size;
        }
      } catch (cause) {
        console.error("[automation] 读冷归档做对账失败，按没有处理", cause);
      }
    }
    // 超限时按结束时间新→旧排好再裁：挤出去的才一定是最旧的（外部迁入乱序时不能按数组位置裁）
    if (full.archive.length > AUTOMATION_ARCHIVE_KEEP) full.archive = [...full.archive].sort((a, b) => b.updatedAt - a.updatedAt);
    const { kept, evicted } = trimArchive(full.archive);
    let reconciled: Snapshot = { live: full.live, archive: kept, older: olderBase, cold };
    // 挤出热归档的先追加进冷文件并落盘，之后才从热文件里拿掉。追加失败：不挤出（热归档暂时超限，下次写入再试），不丢
    if (evicted.length > 0) {
      try {
        await appendCold(this.coldPath, evicted);
        reconciled = { ...reconciled, older: olderBase + evicted.length, cold: await coldMarkOf(this.coldPath) };
      } catch (cause) {
        console.error("[automation] 追加冷归档失败，热归档暂不裁剪，下次写入时再试", cause);
        reconciled = { live: full.live, archive: full.archive, older: olderBase, cold };
      }
    }
    // 对账改动了哪边就写哪边：先写接收方（归档）后写交出方（主文件）。失败不抛：内存是对的，下一次写入补上
    const archiveChanged =
      !sameItems(reconciled.archive, archiveFile.list) || reconciled.older !== archiveFile.older || !sameMark(reconciled.cold, archiveFile.cold);
    const liveChanged = !sameItems(reconciled.live, liveFile.list);
    try {
      if (archiveChanged) await this.writeArchive(reconciled);
    } catch (cause) {
      console.error("[automation] 对账后写归档失败，下次写入时补上", cause);
      this.stale.archive = true;
      // 归档没落盘就不动主文件：主文件里的 completed 是它们此刻唯一的盘上副本
      this.stale.live = liveChanged;
      this.snapshot = reconciled;
      await this.finishLoad();
      return reconciled;
    }
    try {
      if (liveChanged) await this.writeLive(reconciled.live);
    } catch (cause) {
      console.error("[automation] 对账后写主文件失败，下次写入时补上", cause);
      this.stale.live = true;
    }
    this.snapshot = reconciled;
    await this.finishLoad();
    return reconciled;
  }

  /** 读盘对账收尾：给两份文件记基线指纹、记下数据目录的 inode、读还没确认的告警 */
  private async finishLoad(): Promise<void> {
    await Promise.all([this.liveTrack.baseline(), this.archiveTrack.baseline()]).catch((cause: unknown) => console.error("[automation] 记文件指纹失败", cause));
    this.dirIno = await dirInode(this.dir);
    this.alerts = await readUnacknowledged(this.eventsPath);
  }

  /** 原子写主文件并记指纹；写失败时旧的与想写的内容都认（半成品落盘不算篡改） */
  private async writeLive(live: readonly Automation[]): Promise<void> {
    const text = serialize({ version: FILE_VERSION, automations: live });
    try {
      await this.liveTrack.rewrite(text);
    } catch (cause) {
      this.liveTrack.acceptAlso(text);
      throw cause;
    }
  }

  private async writeArchive(snapshot: Snapshot): Promise<void> {
    const text = serialize({ version: FILE_VERSION, automations: snapshot.archive, older: snapshot.older, ...(snapshot.cold === null ? {} : { cold: snapshot.cold }) });
    try {
      await this.archiveTrack.rewrite(text);
    } catch (cause) {
      this.archiveTrack.acceptAlso(text);
      throw cause;
    }
  }

  /** 记一条事件：追加事件文件、进内存告警、通知 renderer 重拉。记事件失败不影响主流程 */
  private async recordEvent(kind: AutomationGuardKind, file: string, extra: { records?: number; backup?: string }): Promise<void> {
    const event: AutomationGuardEvent = { at: this.now(), file, kind, ...extra };
    console.warn(`[automation] 记录文件被动过：${file}（${kind}）`);
    await appendGuardLine(this.eventsPath, event);
    this.alerts = [event, ...this.alerts];
    this.hooks.onGuardEvent?.();
  }

  /**
   * 核对盘上的主文件与热归档是不是还是我们上次写的那份，不是就按**内存里的真源**写回并留事件：
   * 缺失 → 写回；被改 → 被改的那份改名留成 `.tampered-<时间戳>`（给人看，不是备份来源）再写回；
   * 数据目录整个被改名 / 删除后重建（inode 变了或目录不见了）→ 一条事件说明，文件照样写回。
   * 在写入链里跑（不会撞上自己的写入）；任何一步失败只留日志，不抛。
   */
  private async verify(): Promise<void> {
    const snapshot = this.snapshot;
    if (snapshot === null) return;
    try {
      let dirReplaced = false;
      const dirNow = await dirInodeOrMissing(this.dir);
      if (dirNow === "missing") {
        await mkdir(this.dir, { recursive: true });
        dirReplaced = true;
      } else if (this.dirIno !== null && dirNow !== null && dirNow !== this.dirIno) {
        dirReplaced = true;
      }
      if (dirReplaced) this.dirIno = await dirInode(this.dir);
      let restored = 0;
      const targets: { track: TrackedFile; name: string; text: () => string; records: number }[] = [
        { track: this.liveTrack, name: basename(this.filePath), text: () => serialize({ version: FILE_VERSION, automations: snapshot.live }), records: snapshot.live.length },
        {
          track: this.archiveTrack,
          name: basename(this.archivePath),
          text: () =>
            serialize({ version: FILE_VERSION, automations: snapshot.archive, older: snapshot.older, ...(snapshot.cold === null ? {} : { cold: snapshot.cold }) }),
          records: snapshot.archive.length,
        },
      ];
      for (const target of targets) {
        const check = await target.track.check();
        if (check.state === "ok" || check.state === "unknown") continue;
        let backup: string | undefined;
        if (check.state === "changed") {
          backup = `${basename(target.track.path)}.tampered-${this.now()}`;
          await rename(target.track.path, join(this.dir, backup)).catch((cause: unknown) => console.error("[automation] 被改的文件留底失败", cause));
          await this.pruneTamperedBackups(basename(target.track.path));
        }
        await target.track.rewrite(target.text());
        restored += target.records;
        if (!dirReplaced) await this.recordEvent(check.state === "missing" ? "missing" : "changed", target.name, { records: target.records, ...(backup === undefined ? {} : { backup }) });
      }
      if (dirReplaced) await this.recordEvent("dataDirReplaced", "(data folder)", { records: restored });
    } catch (cause) {
      console.error("[automation] 核对记录文件失败（下次再核对）", cause);
    }
  }

  /** `.tampered-<时间戳>` 留底只留最新几份（时间戳是定长数字，字典序即时间序） */
  private async pruneTamperedBackups(base: string): Promise<void> {
    try {
      const names = (await readdir(this.dir)).filter((name) => name.startsWith(`${base}.tampered-`)).sort();
      for (const old of names.slice(0, Math.max(0, names.length - TAMPERED_BACKUPS_KEPT))) await unlink(join(this.dir, old)).catch(() => undefined);
    } catch (cause) {
      console.error("[automation] 清理旧的留底失败", cause);
    }
  }

  /** 对着水位核对冷文件；对不上就留事件并把水位以当前文件为准重新记。返回当前（可能已更新的）水位 */
  private async verifyCold(snapshot: Snapshot): Promise<ColdMark | null> {
    if (snapshot.cold === null) return snapshot.cold;
    try {
      const state = await checkColdMark(this.coldPath, snapshot.cold);
      if (state === "ok") return snapshot.cold;
      await this.recordEvent(state === "missing" ? "coldMissing" : "coldChanged", AUTOMATION_COLD_FILE_NAME, {});
      return await coldMarkOf(this.coldPath);
    } catch (cause) {
      console.error("[automation] 核对冷归档失败（下次再核对）", cause);
      return snapshot.cold;
    }
  }

  /** 排进写入链、先核对一遍盘再返回内存快照。读取类入口都走它：调度器每个 tick、面板每次重拉都会顺带核对 */
  private async fresh(): Promise<Snapshot> {
    const task = this.chain.then(async () => {
      const snapshot = await this.load();
      await this.verify();
      return snapshot;
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  /**
   * 排进写入链；fn 拿当前两份，返回新的两份与调用方要的结果（返回同一个 Snapshot 对象 = 没变，不写盘）。
   * 落盘前先过 settle：completed 的进归档，被重新启动的回主文件，热归档超限的最旧记录**先追加进冷文件（落盘）**再移除。
   * 写盘成功后才换缓存；任何一步失败，缓存不变，调用方拿到抛错。每次变更前先核对盘（被动过就先按真源写回）。
   */
  private mutate<T>(fn: (current: Snapshot) => { next: Snapshot; result: (settled: Snapshot) => T }): Promise<T> {
    const task = this.chain.then(async () => {
      await this.load();
      await this.verify();
      const current = this.snapshot as Snapshot;
      const { next, result } = fn(current);
      if (next === current) return result(current);
      const { settled: draft, evicted } = settle(current, next);
      let settled = draft;
      const liveChanged = settled.live !== current.live || this.stale.live;
      // 第 0 步：被挤出热归档的先进冷文件（fsync）。中途崩溃最坏是「冷文件里有、热文件里也还有」，
      // 下次重试按 id + updatedAt 去重，不会重复追加；绝不会「两边都没有」。追加前先核对冷文件水位，
      // 对不上就留事件（不悄悄在一个被改过的冷文件后面接着写而不吭声）
      if (evicted.length > 0) {
        await this.verifyCold(current);
        await appendCold(this.coldPath, evicted);
        settled = { ...settled, cold: await coldMarkOf(this.coldPath) };
      }
      const archiveChanged = settled.archive !== current.archive || settled.older !== current.older || !sameMark(settled.cold, current.cold) || this.stale.archive;
      // 谁收新记录谁先写：归档收新的（结束了）→ 先写归档；主文件收回来的（重新启动）→ 先写主文件。
      // 中途崩溃最坏是两边各有一份（读盘时对账），不会两边都没有
      const reviving = settled.live.some((automation) => !current.live.includes(automation) && current.archive.some((old) => old.id === automation.id));
      const writeLive = (): Promise<void> => (liveChanged ? this.writeLive(settled.live) : Promise.resolve());
      const writeArchive = (): Promise<void> => (archiveChanged ? this.writeArchive(settled) : Promise.resolve());
      if (reviving) {
        await writeLive();
        await writeArchive();
      } else {
        await writeArchive();
        await writeLive();
      }
      this.stale = { live: false, archive: false };
      this.snapshot = settled;
      return result(settled);
    });
    // 链上吞掉失败，只把失败交给本次调用方，不让一次写失败卡死后面所有变更
    this.chain = task.catch(() => undefined);
    return task;
  }

  /** 没结束的快照（浅拷贝数组；对象是只读视图，改它要走 update）：调度器与名额都只看它 */
  async list(): Promise<Automation[]> {
    return [...(await this.fresh()).live];
  }

  /**
   * 冷归档的现状：移进冷文件的条数（不读冷文件，数在热归档文件里）、文件名，以及还没被用户确认的篡改告警。
   * 顺带核对冷文件水位：对不上就留事件（并把水位重新记到当前文件）。
   */
  async archiveInfo(): Promise<AutomationArchiveInfo> {
    const snapshot = await this.fresh();
    const task = this.chain.then(async () => {
      const current = this.snapshot ?? snapshot;
      const cold = await this.verifyCold(current);
      if (!sameMark(cold, current.cold)) {
        const next = { ...current, cold };
        await this.writeArchive(next);
        this.snapshot = next;
      }
    });
    this.chain = task.catch(() => undefined);
    await task.catch((cause: unknown) => console.error("[automation] 更新冷归档水位失败", cause));
    return { older: (this.snapshot ?? snapshot).older, file: AUTOMATION_COLD_FILE_NAME, alerts: this.alerts.slice(0, 5), alertsTotal: this.alerts.length };
  }

  /** 用户点了「知道了」：事件文件里追加一行 ack，之后这些不再提示 */
  async ackAlerts(): Promise<void> {
    const task = this.chain.then(async () => {
      await appendGuardLine(this.eventsPath, ackLine(this.now()));
      this.alerts = [];
    });
    this.chain = task.catch(() => undefined);
    await task;
  }

  /**
   * 启动后后台对账（不阻塞启动，不占写入链）：流式数一遍冷文件的键（`id@updatedAt`）——
   * ① `older` 与冷文件不符（捏造、双计、热归档文件缺席时没清点）→ 以冷文件为准；
   * ② 热归档里还留着已在冷文件里的记录（崩溃在「冷已追加、热未写」留下的孤儿副本）→ 从热归档拿掉。
   * 扫描期间冷文件又被追加了（水位变了）就放弃这一次，不拿过时的数去改。
   */
  async auditInBackground(): Promise<void> {
    const snapshot = await this.fresh();
    const sizeBefore = await stat(this.coldPath).then((info) => info.size).catch(() => 0);
    if (sizeBefore === 0 && snapshot.older === 0) return;
    const keys = await scanColdKeys(this.coldPath);
    const task = this.chain.then(async () => {
      const current = this.snapshot ?? snapshot;
      const sizeNow = await stat(this.coldPath).then((info) => info.size).catch(() => 0);
      if (sizeNow !== sizeBefore) return; // 扫描期间被追加过：下次再对
      const orphans = current.archive.filter((record) => keys.has(`${record.id}@${record.updatedAt}`));
      if (orphans.length === 0 && keys.size === current.older) return;
      const next: Snapshot = { ...current, archive: current.archive.filter((record) => !orphans.includes(record)), older: keys.size, cold: await coldMarkOf(this.coldPath) };
      await this.writeArchive(next);
      this.snapshot = next;
      console.info(`[automation] 冷归档对账：older ${current.older} → ${keys.size}，热归档里移除 ${orphans.length} 条已在冷文件的副本`);
    });
    this.chain = task.catch(() => undefined);
    await task.catch((cause: unknown) => console.error("[automation] 冷归档对账失败", cause));
  }

  /** 没结束的 + 已归档的（面板、周看板、agent 要求看已结束时用；调度器不用） */
  async listAll(): Promise<Automation[]> {
    const { live, archive } = await this.fresh();
    return [...live, ...archive];
  }

  async get(id: string): Promise<Automation | null> {
    return (await this.listAll()).find((automation) => automation.id === id) ?? null;
  }

  /** 新增（id 已存在则抛错：id 由调用方铸，撞了是 bug；新增一条已经是 completed 的会直接进归档） */
  insert(automation: Automation): Promise<void> {
    return this.mutate((current) => {
      if (current.live.some((existing) => existing.id === automation.id) || current.archive.some((existing) => existing.id === automation.id)) {
        throw new Error(`automation ${automation.id} already exists`);
      }
      return { next: { ...current, live: [automation, ...current.live] }, result: () => undefined };
    });
  }

  /**
   * 读-改-写一条（主文件里的或归档里的）。fn 收到当前值，返回新值（null = 不改）；返回写入后的值，
   * 条目不存在返回 null。fn 必须同步、纯——它在写入链里跑，别在里面等别的写。
   * 改完 status 变成 completed 就进归档，归档里的被改成非 completed 就回主文件。
   */
  update(id: string, fn: (current: Automation) => Automation | null): Promise<Automation | null> {
    return this.mutate((current) => {
      const liveIndex = current.live.findIndex((automation) => automation.id === id);
      const archiveIndex = liveIndex >= 0 ? -1 : current.archive.findIndex((automation) => automation.id === id);
      const existing = liveIndex >= 0 ? current.live[liveIndex] : current.archive[archiveIndex];
      if (existing === undefined) return { next: current, result: () => null };
      const changed = fn(existing);
      if (changed === null) return { next: current, result: () => existing };
      if (liveIndex >= 0) {
        const live = [...current.live];
        live[liveIndex] = changed;
        return { next: { ...current, live }, result: (settled) => findIn(settled, id) };
      }
      const archive = [...current.archive];
      archive[archiveIndex] = changed;
      return { next: { ...current, archive }, result: (settled) => findIn(settled, id) };
    });
  }

  /** 删一条（它跑出来的会话不删）；返回有没有这条。只有用户在面板里点删除会走到这里 */
  remove(id: string): Promise<boolean> {
    return this.mutate((current) => {
      const inLive = current.live.some((automation) => automation.id === id);
      const inArchive = current.archive.some((automation) => automation.id === id);
      if (!inLive && !inArchive) return { next: current, result: () => false };
      return {
        next: {
          ...current,
          live: inLive ? current.live.filter((automation) => automation.id !== id) : current.live,
          archive: inArchive ? current.archive.filter((automation) => automation.id !== id) : current.archive,
        },
        result: () => true,
      };
    });
  }
}

/** 与 writeJsonAtomic 同一个序列化格式（缩进 2、尾换行）：指纹的哈希要对得上盘上的字节 */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function dirInode(dir: string): Promise<bigint | null> {
  try {
    const ino = (await stat(dir, { bigint: true })).ino;
    return ino === 0n ? null : ino;
  } catch {
    return null;
  }
}

/** 目录不见了返回 "missing"，取不到稳定 inode 返回 null */
async function dirInodeOrMissing(dir: string): Promise<bigint | "missing" | null> {
  try {
    const ino = (await stat(dir, { bigint: true })).ino;
    return ino === 0n ? null : ino;
  } catch (cause) {
    return isNotFound(cause) ? "missing" : null;
  }
}

function sameMark(a: ColdMark | null, b: ColdMark | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.head === b.head && a.tail === b.tail;
}

function findIn(snapshot: Snapshot, id: string): Automation | null {
  return snapshot.live.find((automation) => automation.id === id) ?? snapshot.archive.find((automation) => automation.id === id) ?? null;
}

/** 两个列表是同一批对象（对账没动它们）：按引用逐个比——对账只会增删、不会改写对象 */
function sameItems(a: readonly Automation[], b: readonly Automation[]): boolean {
  return a.length === b.length && a.every((automation, index) => automation === b[index]);
}

/**
 * 变更之后的归位：live 里 completed 的进归档最前、归档里被改成非 completed 的回 live 最前，归档超出条数上限的最旧记录挤出。
 * 移动的那份 updatedAt 保证严格大于它留在另一份文件里的旧副本（读盘对账靠它定胜负）。
 * 挤出的（evicted）由调用方先追加进冷文件再落热文件，older 在这里就加上。
 * 没有要动的就原样返回（引用不变 = 该份文件不用重写）。
 */
function settle(before: Snapshot, next: Snapshot): { settled: Snapshot; evicted: Automation[] } {
  const ending = next.live.filter(isFinished);
  const reviving = next.archive.filter((automation) => !isFinished(automation));
  if (ending.length === 0 && reviving.length === 0 && next.archive.length <= AUTOMATION_ARCHIVE_KEEP) return { settled: next, evicted: [] };
  const stamp = (automation: Automation, stale: readonly Automation[]): Automation => {
    const old = stale.find((candidate) => candidate.id === automation.id);
    return old === undefined || automation.updatedAt > old.updatedAt ? automation : { ...automation, updatedAt: old.updatedAt + 1 };
  };
  const live = ending.length === 0 && reviving.length === 0 ? next.live : [...reviving.map((automation) => stamp(automation, before.archive)), ...next.live.filter((automation) => !isFinished(automation))];
  // 按结束时间新→旧排好再裁：挤出去的才一定是最旧的（外部迁入乱序、归档里的记录收到迟到结果后 updatedAt 变新，都不能按数组位置裁）
  const ordered = [...ending.map((automation) => stamp(automation, before.live)), ...next.archive.filter(isFinished)].sort((a, b) => b.updatedAt - a.updatedAt);
  const { kept, evicted } = trimArchive(ordered);
  return { settled: { ...next, live, archive: kept, older: next.older + evicted.length }, evicted };
}
