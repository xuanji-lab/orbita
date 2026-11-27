/**
 * 子会话面板「在跑什么」那一行要的转录尾窗：哪些子会话该读、读过的怎么不重读、切走怎么停。
 *
 * 一次 `session:load` = 主进程把那条子会话的整份 JSONL 读进来、逐行解析、折叠回退（几十到几百 MB，
 * 每次堵主进程 0.1–0.3 秒）。面板每次挂载、父会话每次切换都会问一遍，所以这里管三件事：
 * 1. **该读谁**：通道摘要取回来之前不知道谁还开着，一个都不读（`openChildIds`）；
 * 2. **读过的不重读**：按子会话 id 缓存，`updatedAt` 没变就是新的（`TailCache`，LRU 有上限）；
 *    在途的同一条只发一次；
 * 3. **切走就停**：排队里还没发出去的读取在取消后不再发（`readChildTails`）。
 */
import type { ChannelSummary } from "@shared/channel";
import type { SessionMeta, SessionWindowDetail, TranscriptRecord } from "@shared/session";

export type ChildTail = readonly TranscriptRecord[];

/**
 * 转录尾巴只给「通道还开着」的读（在跑什么、计划在做哪步）；交回 / 失败 / 停止的不读。
 * 摘要还没取回来（`ready` 为假）时不知道谁开着：一个都不读——以前把「没有摘要」当成「开着」，
 * 面板刚挂载那一瞬间全部子会话（实测 d723bd6c 的 25 个、395 MB）被读一遍，摘要回来再读真开着的一遍。
 * 摘要取回后没有摘要的子会话没有通道，也不读：它若真在跑，引擎槽里有实时记录，不用读盘。
 */
export function openChildIds(
  children: readonly SessionMeta[],
  summaries: ReadonlyMap<string, ChannelSummary>,
  ready: boolean,
): string[] {
  if (!ready) return [];
  return children.filter((meta) => summaries.get(meta.id)?.status === "running").map((meta) => meta.id);
}

interface TailEntry {
  updatedAt: number;
  records: ChildTail;
}

/** 按子会话 id 缓存的尾窗，最近用到的留下（Map 的插入序当 LRU 序），超过上限丢最久没用的 */
export class TailCache {
  private readonly entries = new Map<string, TailEntry>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** 拿到什么就是什么（可能已过期）：重读完成前先画旧的，比空着好 */
  peek(id: string): ChildTail | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.records;
  }

  /** 缓存的就是这个 updatedAt 的那一版——不需要再读 */
  isFresh(id: string, updatedAt: number): boolean {
    return this.entries.get(id)?.updatedAt === updatedAt;
  }

  set(id: string, updatedAt: number, records: ChildTail): void {
    this.entries.delete(id);
    this.entries.set(id, { updatedAt, records });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** 面板用的那一份（模块级：面板卸载重挂、换父会话再换回来都还在）。每条最多一个首屏尾窗，64 条封顶 */
export const childTailCache = new TailCache(64);

/** 同一条（id + updatedAt）在途只发一次：多个面板实例 / 重复挂载共用同一次读 */
const inflight = new Map<string, Promise<void>>();

export interface TailWant {
  id: string;
  updatedAt: number;
}

export interface ReadTailsOptions {
  load: (id: string) => Promise<SessionWindowDetail | null>;
  cache: TailCache;
  /** 每次要发新读取之前问一次：真就停（切走 / 换父会话 / 卸载） */
  isCancelled: () => boolean;
  /** 同时在途的读取数（主进程是单线程，多发只是排队，不更快） */
  concurrency?: number;
}

/**
 * 把 wanted 里缓存过期的读一遍（并发 `concurrency` 路），读完写进缓存。缓存新鲜的不读。
 * 返回实际发出的读取数。取消后队列里没发出去的就不发了；已经在途的读完照样写缓存（数据本身没错）。
 */
export async function readChildTails(wanted: readonly TailWant[], options: ReadTailsOptions): Promise<number> {
  const { load, cache, isCancelled } = options;
  const queue = wanted.filter((want) => !cache.isFresh(want.id, want.updatedAt));
  let issued = 0;
  const worker = async (): Promise<void> => {
    for (let want = queue.shift(); want !== undefined; want = queue.shift()) {
      if (isCancelled()) return;
      const key = `${want.id}:${want.updatedAt}`;
      let pending = inflight.get(key);
      if (pending === undefined) {
        const { id, updatedAt } = want;
        issued += 1;
        pending = load(id)
          .catch(() => null)
          .then((detail) => {
            // 读失败也记一个空尾窗：同一版不重试，updatedAt 变了才再读
            cache.set(id, updatedAt, (detail?.transcript ?? []) as ChildTail);
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, pending);
      }
      await pending;
    }
  };
  const width = Math.max(1, options.concurrency ?? 4);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return issued;
}
