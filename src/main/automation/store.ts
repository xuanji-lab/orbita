/**
 * 自动化的落盘：userData 下两份文件。
 *
 * - `automations.json`：**没结束的**（active / paused / failed），条数受 AUTOMATION_MAX_UNFINISHED 约束，
 *   调度器每 30 秒的 tick 只看它；
 * - `automations-archive.json`：**已结束的**（completed）归档，最新结束的在前，最多留 AUTOMATION_ARCHIVE_KEEP 条，
 *   超出的从最旧的丢。归档不进 tick、不占名额，只被面板与 `automation_list`（要求时）读。
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
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { AUTOMATION_ARCHIVE_KEEP, isFinished, parseAutomation, type Automation } from "../../shared/automation.ts";
import { writeJsonAtomic } from "../atomic-write.ts";

const FILE_NAME = "automations.json";
const ARCHIVE_FILE_NAME = "automations-archive.json";
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

/** 工具禁区的单文件清单：两份记录都不许智能体的 write / edit / bash 碰（连同它们的 `.tmp` / `.bad-` 兄弟，匹配在 agent/permission.ts） */
export function automationProtectedFiles(dir: string): string[] {
  return [automationStoreFilePath(dir), automationArchiveFilePath(dir)];
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
}

/** 读一份文件成列表：不存在 = 空；坏 JSON 改名留底后从空开始；单条残缺只丢那一条；读不了（权限等）照抛 */
async function readAutomationFile(filePath: string, now: () => number): Promise<Automation[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return [];
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
    return [];
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
  return list;
}

/** 内存里的两份：live = 没结束的，archive = 已结束的（最新结束的在前） */
interface Snapshot {
  live: readonly Automation[];
  archive: readonly Automation[];
}

/**
 * 读盘后的对账：两份里同一 id 出现两次（移动到一半崩溃的残影）按 updatedAt 定胜负；
 * live 里已经是 completed 的（升级前的老数据 / 崩溃残影）移进归档；归档按条数上限截断。
 */
export function reconcileSnapshot(live: readonly Automation[], archive: readonly Automation[]): Snapshot {
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
  return { live: keepLive, archive: [...migrating, ...keptArchive].slice(0, AUTOMATION_ARCHIVE_KEEP) };
}

export class AutomationStore {
  private readonly filePath: string;
  private readonly archivePath: string;
  private snapshot: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;
  /** 读盘对账后写盘失败的：内存已经是对的，磁盘还没跟上；下一次成功的写入顺带补上 */
  private stale = { live: false, archive: false };
  /** 写入链：所有变更串行，任何一步失败不卡死后面的 */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.filePath = automationStoreFilePath(dir);
    this.archivePath = automationArchiveFilePath(dir);
    this.now = now;
  }

  private load(): Promise<Snapshot> {
    if (this.snapshot !== null) return Promise.resolve(this.snapshot);
    this.loading ??= this.readAndReconcile();
    return this.loading;
  }

  private async readAndReconcile(): Promise<Snapshot> {
    const live = await readAutomationFile(this.filePath, this.now);
    const archive = await readAutomationFile(this.archivePath, this.now);
    const reconciled = reconcileSnapshot(live, archive);
    // 对账改动了哪边就写哪边：先写接收方（归档）后写交出方（主文件）。失败不抛：内存是对的，下一次写入补上
    const archiveChanged = !sameItems(reconciled.archive, archive);
    const liveChanged = !sameItems(reconciled.live, live);
    try {
      if (archiveChanged) await writeJsonAtomic(this.archivePath, { version: FILE_VERSION, automations: reconciled.archive });
    } catch (cause) {
      console.error("[automation] 对账后写归档失败，下次写入时补上", cause);
      this.stale.archive = true;
      // 归档没落盘就不动主文件：主文件里的 completed 是它们此刻唯一的盘上副本
      this.stale.live = liveChanged;
      this.snapshot = reconciled;
      return reconciled;
    }
    try {
      if (liveChanged) await writeJsonAtomic(this.filePath, { version: FILE_VERSION, automations: reconciled.live });
    } catch (cause) {
      console.error("[automation] 对账后写主文件失败，下次写入时补上", cause);
      this.stale.live = true;
    }
    this.snapshot = reconciled;
    return reconciled;
  }

  /**
   * 排进写入链；fn 拿当前两份，返回新的两份与调用方要的结果（返回同一个 Snapshot 对象 = 没变，不写盘）。
   * 落盘前先过 settle：completed 的进归档，被重新启动的回主文件。写盘成功后才换缓存。
   */
  private mutate<T>(fn: (current: Snapshot) => { next: Snapshot; result: (settled: Snapshot) => T }): Promise<T> {
    const task = this.chain.then(async () => {
      const current = await this.load();
      const { next, result } = fn(current);
      if (next === current) return result(current);
      const settled = settle(current, next);
      const liveChanged = settled.live !== current.live || this.stale.live;
      const archiveChanged = settled.archive !== current.archive || this.stale.archive;
      // 谁收新记录谁先写：归档收新的（结束了）→ 先写归档；主文件收回来的（重新启动）→ 先写主文件。
      // 中途崩溃最坏是两边各有一份（读盘时对账），不会两边都没有
      const reviving = settled.live.some((automation) => !current.live.includes(automation) && current.archive.some((old) => old.id === automation.id));
      const writeLive = (): Promise<void> => (liveChanged ? writeJsonAtomic(this.filePath, { version: FILE_VERSION, automations: settled.live }) : Promise.resolve());
      const writeArchive = (): Promise<void> => (archiveChanged ? writeJsonAtomic(this.archivePath, { version: FILE_VERSION, automations: settled.archive }) : Promise.resolve());
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
    await this.chain;
    return [...(await this.load()).live];
  }

  /** 没结束的 + 已归档的（面板、周看板、agent 要求看已结束时用；调度器不用） */
  async listAll(): Promise<Automation[]> {
    await this.chain;
    const { live, archive } = await this.load();
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
      return { next: { live: [automation, ...current.live], archive: current.archive }, result: () => undefined };
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
        return { next: { live, archive: current.archive }, result: (settled) => findIn(settled, id) };
      }
      const archive = [...current.archive];
      archive[archiveIndex] = changed;
      return { next: { live: current.live, archive }, result: (settled) => findIn(settled, id) };
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
          live: inLive ? current.live.filter((automation) => automation.id !== id) : current.live,
          archive: inArchive ? current.archive.filter((automation) => automation.id !== id) : current.archive,
        },
        result: () => true,
      };
    });
  }
}

function findIn(snapshot: Snapshot, id: string): Automation | null {
  return snapshot.live.find((automation) => automation.id === id) ?? snapshot.archive.find((automation) => automation.id === id) ?? null;
}

/** 两个列表是同一批对象（对账没动它们）：按引用逐个比——对账只会增删、不会改写对象 */
function sameItems(a: readonly Automation[], b: readonly Automation[]): boolean {
  return a.length === b.length && a.every((automation, index) => automation === b[index]);
}

/**
 * 变更之后的归位：live 里 completed 的进归档最前、归档里被改成非 completed 的回 live 最前，归档超出条数上限的丢最旧。
 * 移动的那份 updatedAt 保证严格大于它留在另一份文件里的旧副本（读盘对账靠它定胜负）。
 * 没有要动的就原样返回（引用不变 = 该份文件不用重写）。
 */
function settle(before: Snapshot, next: Snapshot): Snapshot {
  const ending = next.live.filter(isFinished);
  const reviving = next.archive.filter((automation) => !isFinished(automation));
  if (ending.length === 0 && reviving.length === 0 && next.archive.length <= AUTOMATION_ARCHIVE_KEEP) return next;
  const stamp = (automation: Automation, stale: readonly Automation[]): Automation => {
    const old = stale.find((candidate) => candidate.id === automation.id);
    return old === undefined || automation.updatedAt > old.updatedAt ? automation : { ...automation, updatedAt: old.updatedAt + 1 };
  };
  const live = ending.length === 0 && reviving.length === 0 ? next.live : [...reviving.map((automation) => stamp(automation, before.archive)), ...next.live.filter((automation) => !isFinished(automation))];
  const archive = [...ending.map((automation) => stamp(automation, before.live)), ...next.archive.filter(isFinished)].slice(0, AUTOMATION_ARCHIVE_KEEP);
  return { live, archive };
}
