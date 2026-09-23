/**
 * 父会话的通道摘要（子会话 PR4a）：派出卡与通道列（下一个 PR）共用的状态源。
 *
 * `channel:list` 是主进程现算的（status/messageCount/lastAt/hasExchange，见
 * `shared/channel.ts` 的 `summarizeChannel`）——这里不再自己聚合，只负责什么时候
 * 拉一次：parentId 变化时拉一次，此后订阅 `channel:event`，事件属于这个父就重新拉
 * 一遍。**不做增量合并**：通道消息量小（一对父子的往来），简单可靠优先；下一个
 * PR 的通道列面板也吃这个 hook，届时如果增量真的必要再抽。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { ChannelSummary } from "@shared/channel";

export function useChannelSummaries(parentId: string | null): ReadonlyMap<string, ChannelSummary> {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, ChannelSummary>>(new Map());

  useEffect(() => {
    if (parentId === null) {
      setSummaries(new Map());
      return;
    }
    let cancelled = false;
    const refresh = (): void => {
      void api.channel
        .list(parentId)
        .then((list) => {
          if (cancelled) return;
          setSummaries(new Map(list.map((summary) => [summary.childId, summary])));
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

  return summaries;
}
