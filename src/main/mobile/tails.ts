/**
 * 手机读尾部：`tail.load` 的翻页与 `tail.changed` 的推送。
 *
 * - 首页从文件尾读；往更早翻按窗口的「续读点」走，最多 8 个窗口（常规 2 MB），找不到锚点回
 *   `not_found`，绝不从头扫整份。多个窗口的记录先拼回文件序，再统一折叠回退与过程条目——
 *   不能让一次工具调用串在窗口边界被切成两条。
 * - `rev` 是转录文件的字节数：文件只追加，落一条终态记录就变，跨重启也稳定，不需要另存计数器。
 *   手机只拿它判「变了没有」。推送在终态记录事件后攒 400 ms，再 stat 一次；文件没变不推。
 * - 全局一次只做一份尾部分页，防止多台手机同时翻页把主进程读盘打满。
 *
 * 纯核 + 依赖注入：不 import electron，`node --test` 直测。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionRecord } from "../../shared/session.ts";
import { tailEntriesOf, tailPageOf } from "../../shared/mobile-tail.ts";
import { MOBILE_TAIL_PAGE, type TailEntry } from "../../shared/mobile.ts";
import { foldRevertRecords, type TailReadOptions, type TailWindow } from "../session/store.ts";

const MAX_BACK_WINDOWS = 8;
const FLUSH_DELAY_MS = 400;

export interface TailsDeps {
  tailWindow(id: string, options: TailReadOptions): Promise<TailWindow | null>;
  /** 只 stat、不读内容；推送前拿文件大小当 rev */
  tailStat(id: string): Promise<{ size: number; mtimeMs: number } | null>;
}

export interface TailPage {
  entries: TailEntry[];
  hasMore: boolean;
  rev: number;
}

interface Watch {
  send(sessionId: string, rev: number): void;
}

export class MobileTails {
  private readonly deps: TailsDeps;
  private readonly revs = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly watches = new Map<string, Set<Watch>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private loads: Promise<unknown> = Promise.resolve();

  constructor(deps: TailsDeps) {
    this.deps = deps;
  }

  revOf(sessionId: string): number {
    return this.revs.get(sessionId) ?? 0;
  }

  /** 一页尾部。文件不存在且不给锚点是空页；锚点找不到返回 null（调用方回 not_found） */
  load(sessionId: string, before?: string): Promise<TailPage | null> {
    const next = this.loads.then(() => this.loadPage(sessionId, before), () => this.loadPage(sessionId, before));
    this.loads = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async loadPage(sessionId: string, before?: string): Promise<TailPage | null> {
    let records: SessionRecord[] = [];
    let endByte: number | undefined;
    let rev = 0;
    let lastPage: { entries: TailEntry[]; hasMore: boolean } | null = null;

    for (let back = 0; back < MAX_BACK_WINDOWS; back += 1) {
      const window = await this.deps.tailWindow(sessionId, {
        maxRecords: Number.POSITIVE_INFINITY,
        ...(endByte === undefined ? {} : { endByte }),
      });
      if (window === null) return before === undefined && back === 0 ? { entries: [], hasMore: false, rev: 0 } : null;
      if (back === 0) {
        rev = window.end;
        this.revs.set(sessionId, rev);
      }
      records = [...window.records, ...records];
      const entries = tailEntriesOf(foldRevertRecords(records));
      const page = tailPageOf(entries, before);
      if (page !== null) {
        lastPage = page;
        // 满一页 / 页内还有更早条目 / 已到文件头就回；否则再往前凑满一页，避免手机原地翻空页
        if (page.entries.length >= MOBILE_TAIL_PAGE || page.hasMore || window.start === 0) {
          return { entries: page.entries, hasMore: page.hasMore || window.start > 0, rev };
        }
      } else if (window.start === 0) {
        return null;
      }
      if (window.start === 0) return page === null ? null : { entries: page.entries, hasMore: page.hasMore, rev };
      const until = endByte ?? window.end;
      // 一行比窗口还大时 next 可能没前进；退到本窗起点找它之前的完整行，不原地打转
      endByte = window.next < until ? window.next : window.start;
      if (endByte >= until) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // 深度到限：找得到锚点就给已读到的一页，否则明确 not_found
    return lastPage === null ? null : { entries: lastPage.entries, hasMore: true, rev };
  }

  /** 同一条连接对同一条会话重复 watch 由调用方幂等；这里每个 Watch 是一份独立订阅 */
  watch(sessionId: string, send: Watch["send"]): () => void {
    const watch: Watch = { send };
    let set = this.watches.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.watches.set(sessionId, set);
    }
    set.add(watch);
    return () => {
      set.delete(watch);
      if (set.size === 0) this.watches.delete(sessionId);
    };
  }

  /** 只在可能落终态记录的事件后标脏。title / stats 不是转录记录，不制造假 rev */
  onAgentEvent(event: AgentEvent): void {
    if (!("sessionId" in event) || event.sessionId === null) return;
    const sessionId = event.sessionId;
    const terminalRecord =
      event.type === "fileTurn" ||
      event.type === "compaction" ||
      event.type === "intentRecallRecord" ||
      (event.type === "progress" &&
        ((event.progress.type === "item_finished" && event.progress.item.role === "assistant") ||
          (event.progress.type === "item_started" && event.progress.item.role === "user")));
    if (!terminalRecord || !this.watches.has(sessionId)) return;
    this.dirty.add(sessionId);
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((cause: unknown) => console.error("[mobile] tail.changed 刷新失败", cause));
    }, FLUSH_DELAY_MS);
  }

  private async flush(): Promise<void> {
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const sessionId of dirty) {
      const set = this.watches.get(sessionId);
      if (set === undefined) continue;
      const info = await this.deps.tailStat(sessionId);
      const rev = info?.size ?? 0;
      if (this.revOf(sessionId) === rev) continue;
      this.revs.set(sessionId, rev);
      for (const watch of set) {
        try {
          watch.send(sessionId, rev);
        } catch (cause) {
          console.error("[mobile] tail.changed 没送出去", cause);
        }
      }
    }
  }
}
