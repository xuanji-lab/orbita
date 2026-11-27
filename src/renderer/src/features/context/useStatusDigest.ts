/**
 * 状态卡摘要的 renderer 一侧（2026-11-27，「主进程算好摘要」）。
 *
 * 主进程把每条会话的记录 fold 成摘要（shared/status-digest.ts，sessions/<id>.status.json），
 * 这里取回，再把**尾窗里比摘要新的记录**用同一个 fold 叠上去——流式中的实时更新全靠这层叠加，
 * 不重新拉。状态卡由此不再 `useTaskRecords(…, true)` 把整条历史逐页拉进 renderer。
 *
 * - `useStatusDigest`：主会话的摘要 + 叠好尾巴的 fold 状态。摘要在首次拉取 / 回退重算途中时，
 *   先拿活窗（尾窗）折一份顶着——与旧路径首屏只看见尾窗的行为一致，摘要到了再换。
 * - `useChildDigests`：全部子会话的摘要，一批一次 IPC；按 meta.updatedAt 失效重取
 *   （与旧 useChildTails 同一节奏），模块级缓存保住切回的第一帧。
 */
import { useEffect, useMemo, useState } from "react";
import type { SessionMeta, TranscriptRecord } from "@shared/session";
import { api } from "../../api.ts";
import {
  cloneStatusDigestState,
  emptyStatusDigestState,
  foldStatusRecord,
  type StatusDigestState,
} from "../../../../shared/status-digest.ts";
import type { SessionEntry } from "../chat/session-states.ts";

/**
 * 尾窗里比摘要新的记录：位于 lastId 之后、且不在 recentIds 里。
 * - lastId 为 null（空摘要 / 新会话）：整条活窗都是新的；
 * - lastId 不在尾窗里：摘要比槽新（事件还在路上）或刚回退（重算在途）——不叠，等重取 / 事件追平，
 *   绝不把对不上的记录折进去；
 * - recentIds：同毫秒重排会让一两条已折记录排到 lastId 之后（mergeSideRecords 的 rank 序），挡住它们折第二次。
 */
function tailOf(digest: StatusDigestState, current: readonly TranscriptRecord[]): TranscriptRecord[] {
  const lastId = digest.meta.lastId;
  if (lastId === null) return [...current];
  const at = current.findIndex((record) => record.id === lastId);
  if (at < 0) return [];
  const recent = new Set(digest.meta.recentIds);
  return current.slice(at + 1).filter((record) => !recent.has(record.id));
}

export function useStatusDigest(
  sessionId: string,
  entry: SessionEntry,
  current: readonly TranscriptRecord[],
): StatusDigestState {
  const [fetched, setFetched] = useState<{ id: string; state: StatusDigestState | null }>({ id: sessionId, state: null });
  // 回退会让主进程全量重算摘要：revert 界碑进槽时重取（取摘要排在重算后面，拿到的是新的）
  const reverts = entry.reverts.length;
  useEffect(() => {
    let live = true;
    void api.session
      .statusDigests([sessionId])
      .then((map) => {
        if (live) setFetched({ id: sessionId, state: map[sessionId] ?? null });
      })
      .catch((cause: unknown) => console.error("[status-digest] 摘要读取失败", sessionId, cause));
    return () => {
      live = false;
    };
  }, [sessionId, reverts]);
  // 换会话的那一帧不用上一条的摘要（fetched.id 对不上就当还没到）
  const digest = fetched.id === sessionId ? fetched.state : null;
  return useMemo(() => {
    if (digest === null) {
      const state = emptyStatusDigestState();
      for (const record of current) foldStatusRecord(state, record);
      return state;
    }
    const tail = tailOf(digest, current);
    if (tail.length === 0) return digest;
    const state = cloneStatusDigestState(digest);
    for (const record of tail) foldStatusRecord(state, record);
    return state;
  }, [digest, current]);
}

/**
 * 子会话摘要的跨挂载缓存（按子会话 id；updatedAt 没变就不重取）：状态卡按会话重挂，
 * 不缓存的话每次切回都要重取一遍，卡里「在跑的」先空再出（与旧 childTailCache 同一个理由）。
 */
const childDigestCache = new Map<string, { updatedAt: number; state: StatusDigestState | null }>();
const CHILD_CACHE_CAP = 200;

function cachedChildDigests(kids: readonly SessionMeta[]): Map<string, StatusDigestState | null> {
  const map = new Map<string, StatusDigestState | null>();
  for (const meta of kids) {
    const hit = childDigestCache.get(meta.id);
    if (hit !== undefined) map.set(meta.id, hit.state);
  }
  return map;
}

export function useChildDigests(kids: readonly SessionMeta[]): ReadonlyMap<string, StatusDigestState | null> {
  // 第一帧就用缓存里旧的，后台再校验
  const [states, setStates] = useState<ReadonlyMap<string, StatusDigestState | null>>(() => cachedChildDigests(kids));
  const key = kids.map((meta) => `${meta.id}:${meta.updatedAt}`).join(",");
  useEffect(() => {
    let live = true;
    setStates(cachedChildDigests(kids));
    const stale = kids.filter((meta) => childDigestCache.get(meta.id)?.updatedAt !== meta.updatedAt);
    if (stale.length === 0) return undefined;
    void api.session
      .statusDigests(stale.map((meta) => meta.id))
      .then((map) => {
        for (const meta of stale) {
          childDigestCache.set(meta.id, { updatedAt: meta.updatedAt, state: map[meta.id] ?? null });
        }
        //  capped：删最久没动的（Map 保插入序，删头）
        while (childDigestCache.size > CHILD_CACHE_CAP) {
          const oldest = childDigestCache.keys().next().value;
          if (oldest === undefined) break;
          childDigestCache.delete(oldest);
        }
        if (live) setStates(cachedChildDigests(kids));
      })
      .catch((cause: unknown) => console.error("[status-digest] 子会话摘要读取失败", cause));
    return () => {
      live = false;
    };
    // kids 的内容由 key 代表
  }, [key]);
  return states;
}
