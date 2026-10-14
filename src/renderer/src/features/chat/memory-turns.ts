/**
 * 会话记忆的按轮数据（审查面板记忆页签 + 轮尾卡记忆行共用）：
 * useMemoryTurns 负责「什么时候重拉」（挂载 + 每轮落定），memoryTurnCounts 把
 * 主进程的按轮汇总折成轮尾卡要的三个数（新增 / 可能推翻 / 用到）。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { MemorySessionTurnsResponse } from "@shared/memory";

/**
 * 按轮拉这个会话的记忆账（注入 / 新增 / 冲突）。重拉时机：换会话、每轮落定
 * （phase 回 idle）——蒸馏是轮后异步落盘的，回 idle 后再等一小拍（400ms）拿
 * 的是蒸完的结果；流式过程中不重拉（那是每秒几十次的事件，记忆账不值得跟）。
 * 失败静默（null）：记忆页签与轮尾卡行都是锦上添花，不该为此报错。
 */
export function useMemoryTurns(sessionId: string | null, phase: string): MemorySessionTurnsResponse | null {
  const [data, setData] = useState<MemorySessionTurnsResponse | null>(null);
  const [epoch, setEpoch] = useState(0);
  const prevPhase = useRef(phase);
  useEffect(() => {
    if (prevPhase.current === phase) return;
    prevPhase.current = phase;
    if (phase === "idle") setEpoch((count) => count + 1);
  }, [phase]);
  useEffect(() => {
    if (sessionId === null) {
      setData(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.memory
        .sessionTurns(sessionId)
        .then((result) => {
          if (!cancelled) setData(result);
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, epoch]);
  return data;
}

export interface MemoryTurnCounts {
  added: number;
  conflicts: number;
  used: number;
}

/** 轮号 → 轮尾卡的三个数。冲突数只算还没拍板的（pendingConflicts 的轮内版）。 */
export function memoryTurnCounts(response: MemorySessionTurnsResponse | null): Map<number, MemoryTurnCounts> {
  const counts = new Map<number, MemoryTurnCounts>();
  if (response === null) return counts;
  for (const turn of response.turns) {
    counts.set(turn.turn, {
      added: turn.added.length,
      conflicts: turn.added.filter((added) => added.conflictWith !== null).length,
      used: turn.injected.length,
    });
  }
  return counts;
}
