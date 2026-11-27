/**
 * 父会话的通道摘要（子会话 PR4a）：派出卡与通道列（下一个 PR）共用的状态源。
 *
 * `channel:list` 是主进程现算的（status/messageCount/lastAt/hasExchange，见
 * `shared/channel.ts` 的 `summarizeChannel`）——这里不再自己聚合，只负责什么时候
 * 拉一次：parentId 变化时拉一次，此后订阅 `channel:event`，事件属于这个父就重新拉
 * 一遍。**不做增量合并**：通道消息量小（一对父子的往来），简单可靠优先；下一个
 * PR 的通道列面板也吃这个 hook，届时如果增量真的必要再抽。
 *
 * **摘要属于哪个父要记着**：换父会话的那一帧，state 里还是上一个父的摘要。拿它去判新父的子会话
 * 全是「没有摘要」，调用方会以为都还开着、全读一遍。所以 state 带着它是哪个父的，
 * 对不上就当没有（空表 + `ready: false`）。`ready` 告诉调用方「这个父的摘要已经取回来过」——
 * 区分「还没取回来」与「取回来了、这个子会话没有通道」。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { ChannelSummary } from "@shared/channel";
import { pickSummaries, type ChannelSummariesState, type LoadedSummaries } from "./summaries-pick.ts";

export function useChannelSummariesState(parentId: string | null): ChannelSummariesState {
  const [loaded, setLoaded] = useState<LoadedSummaries | null>(null);

  useEffect(() => {
    if (parentId === null) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    const refresh = (): void => {
      void api.channel
        .list(parentId)
        .then((list) => {
          if (cancelled) return;
          setLoaded({ parentId, summaries: new Map(list.map((summary) => [summary.childId, summary])) });
        })
        .catch((cause: unknown) => {
          // 错误不吞：读不出来打到控制台，旧值保留——一次网络抖动不该让已知的
          // 派出卡状态集体消失
          console.error("[channel] 通道列表读取失败", parentId, cause);
        });
    };
    refresh();
    const off = api.channel.onEvent((event) => {
      if (event.parentId === parentId) refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [parentId]);

  return pickSummaries(loaded, parentId);
}

export function useChannelSummaries(parentId: string | null): ReadonlyMap<string, ChannelSummary> {
  return useChannelSummariesState(parentId).summaries;
}
