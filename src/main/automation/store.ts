/**
 * 自动化的落盘（实验功能 automation）：userData 下一份 `automations.json`。
 *
 * - **全量常驻内存**：自动化是用户手建的少量对象（每条最多 50 条 runs），整份读进来比逐条读盘简单，
 *   也让调度器每 30 秒的 tick 不碰磁盘。
 * - **写入串行 + 原子写**：所有变更排进同一条链，每次整份经 `writeJsonAtomic`（临时文件 + rename）
 *   落盘；写失败时内存不变（先写盘、成功后才换缓存），调用方拿到抛错。
 * - **坏文件不吞用户的数据**：整份 JSON 解析失败 → 原文件改名为 `automations.json.bad-<时间戳>` 留给人看，
 *   再从空开始；单条解析失败（字段残缺）只丢那一条。两种都在 dev 终端留一行原因。
 */
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseAutomation, type Automation } from "../../shared/automation.ts";
import { writeJsonAtomic } from "../atomic-write.ts";

const FILE_NAME = "automations.json";
const FILE_VERSION = 1;

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";
}

export class AutomationStore {
  private readonly filePath: string;
  private cache: Automation[] | null = null;
  /** 写入链：所有变更串行，任何一步失败不卡死后面的 */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.filePath = join(dir, FILE_NAME);
    this.now = now;
  }

  private async load(): Promise<Automation[]> {
    if (this.cache !== null) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) {
        this.cache = [];
        return this.cache;
      }
      // 读不了 ≠ 没有：权限等问题照抛，别吞成空列表再被下一次写盘覆盖
      throw cause;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      const aside = `${this.filePath}.bad-${this.now()}`;
      console.error(`[automation] ${FILE_NAME} 不是合法 JSON，已改名为 ${aside} 并从空开始`, cause);
      await rename(this.filePath, aside).catch((renameCause: unknown) => {
        console.error("[automation] 坏文件改名失败", renameCause);
      });
      this.cache = [];
      return this.cache;
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
    this.cache = list;
    return list;
  }

  /** 排进写入链；fn 拿当前全量，返回新全量与调用方要的结果。写盘成功后才换缓存 */
  private mutate<T>(fn: (current: readonly Automation[]) => { next: Automation[]; result: T }): Promise<T> {
    const task = this.chain.then(async () => {
      const current = await this.load();
      const { next, result } = fn(current);
      if (next !== current) {
        await writeJsonAtomic(this.filePath, { version: FILE_VERSION, automations: next });
        this.cache = next;
      }
      return result;
    });
    // 链上吞掉失败，只把失败交给本次调用方，不让一次写失败卡死后面所有变更
    this.chain = task.catch(() => undefined);
    return task;
  }

  /** 全量快照（浅拷贝数组；对象是只读视图，改它要走 update） */
  async list(): Promise<Automation[]> {
    await this.chain;
    return [...(await this.load())];
  }

  async get(id: string): Promise<Automation | null> {
    return (await this.list()).find((automation) => automation.id === id) ?? null;
  }

  /** 新增（id 已存在则抛错：id 由调用方铸，撞了是 bug） */
  insert(automation: Automation): Promise<void> {
    return this.mutate((current) => {
      if (current.some((existing) => existing.id === automation.id)) throw new Error(`automation ${automation.id} already exists`);
      return { next: [automation, ...current], result: undefined };
    });
  }

  /**
   * 读-改-写一条。fn 收到当前值，返回新值（null = 不改）；返回写入后的值，
   * 条目不存在返回 null。fn 必须同步、纯——它在写入链里跑，别在里面等别的写。
   */
  update(id: string, fn: (current: Automation) => Automation | null): Promise<Automation | null> {
    return this.mutate((current) => {
      const index = current.findIndex((automation) => automation.id === id);
      const existing = current[index];
      if (existing === undefined) return { next: current as Automation[], result: null };
      const changed = fn(existing);
      if (changed === null) return { next: current as Automation[], result: existing };
      const next = [...current];
      next[index] = changed;
      return { next, result: changed };
    });
  }

  /** 删一条（它跑出来的会话不删）；返回有没有这条 */
  remove(id: string): Promise<boolean> {
    return this.mutate((current) => {
      if (!current.some((automation) => automation.id === id)) return { next: current as Automation[], result: false };
      return { next: current.filter((automation) => automation.id !== id), result: true };
    });
  }
}
