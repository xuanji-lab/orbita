/**
 * 子会话转录尾窗的共用缓存（实验分支：切换会话卡顿的改前 / 改后对比）。
 *
 * 状态卡与右栏子会话面板都要「这条子会话此刻在做什么」，取法都是 `session:load` 读它的尾窗——
 * 而 `session:load` 在主进程是整份读盘 + 逐行解析（子会话文件常是几十上百 MB）。以前两处各读各的：
 * 状态卡有自己的缓存，面板没有，每次挂载都把子会话重读一遍。这里收成一份：
 * - 按子会话 id 缓存，meta.updatedAt 没变就不重读；
 * - 同一条子会话同时被两处要，只发一次 IPC（在途去重）。
 */
import type { SessionMeta, TranscriptRecord } from "@shared/session";
import { LruCache } from "../../../../shared/lru.ts";
import { api } from "../../api";

type ChildRef = Pick<SessionMeta, "id" | "updatedAt">;

const cache = new LruCache<{ updatedAt: number; records: readonly TranscriptRecord[] }>(60);
const inflight = new Map<string, Promise<readonly TranscriptRecord[]>>();

/** 缓存里有的就给（可能是旧的：第一帧先用旧的，后台再校验）；没读过 = undefined */
export function peekChildTail(id: string): readonly TranscriptRecord[] | undefined {
  return cache.get(id)?.records;
}

/** 缓存是不是这条 meta 对应的那一版 */
export function childTailFresh(meta: ChildRef): boolean {
  return cache.get(meta.id)?.updatedAt === meta.updatedAt;
}

/** 读一条子会话的尾窗：缓存新鲜直接给；否则读一次（同一版本在途的不重复发） */
export function readChildTail(meta: ChildRef): Promise<readonly TranscriptRecord[]> {
  const hit = cache.get(meta.id);
  if (hit !== undefined && hit.updatedAt === meta.updatedAt) return Promise.resolve(hit.records);
  const key = `${meta.id}:${meta.updatedAt}`;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const request = api.session
    .load(meta.id)
    .catch(() => null)
    .then((detail) => {
      const records = (detail?.transcript ?? []) as readonly TranscriptRecord[];
      cache.set(meta.id, { updatedAt: meta.updatedAt, records });
      inflight.delete(key);
      return records;
    });
  inflight.set(key, request);
  return request;
}
