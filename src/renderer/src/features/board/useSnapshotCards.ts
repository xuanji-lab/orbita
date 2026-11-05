import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardCardSnapshot } from "../../../../shared/plugin-board.ts";
import { api } from "../../api";
import type { BoardCardView } from "../plugins/board-card.ts";
import { snapshotCardView, type FrameState } from "./snapshot-card.ts";

/** 一张要画的快照卡：key 在这一组里唯一（运行 / 工具调用 id + 卡 id + 序号） */
export interface SnapshotCardInput {
  key: string;
  snapshot: BoardCardSnapshot;
  /** 快照里没有数据文件时间（样例 / 空）时发给模板的 updatedAt 兜底：取快照那一刻 */
  at: number;
}

/**
 * 把一组快照卡变成 BoardGrid 的 `BoardCardView[]`：每张卡用模板哈希向主进程换一次性 iframe 地址。
 *
 * **每次挂载各换一次**（地址一次性，主进程只给第一个来取的 iframe），同一个 key 在组件活着期间只换一次——
 * 数据重拉、重渲染都不会换 iframe（否则卡会闪、卡里的状态会丢）。组件卸载（滑出视口的那天、折起的会话）
 * 再回来就重新换。换不到（仓库里没有 / 哈希不合规）画成「这张卡画不出来」。
 */
export function useSnapshotCards(inputs: readonly SnapshotCardInput[]): BoardCardView[] {
  const [frames, setFrames] = useState<ReadonlyMap<string, FrameState>>(new Map());
  const requested = useRef(new Set<string>());
  const counter = useRef(0);
  // 组件还挂着吗：inputs 换了引用不算卸载（在途的请求照常落地），只有真卸载才丢结果
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const input of inputs) {
      if (requested.current.has(input.key)) continue;
      requested.current.add(input.key);
      const settle = (state: FrameState): void => {
        if (mounted.current) setFrames((current) => new Map(current).set(input.key, state));
      };
      api.board
        .frame({ hash: input.snapshot.template })
        .then((result) => {
          counter.current += 1;
          settle(result === null ? { kind: "missing" } : { kind: "ready", frameUrl: result.frameUrl, frameKey: counter.current });
        })
        .catch(() => settle({ kind: "missing" }));
    }
  }, [inputs]);
  return useMemo(
    () => inputs.map((input) => snapshotCardView(input.key, input.snapshot, frames.get(input.key) ?? { kind: "pending" }, input.at)),
    [inputs, frames],
  );
}
