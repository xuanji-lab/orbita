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

/**
 * 侧栏用：好几个主智能体（每个工作区一个）派出去的活，各自的通道状态（子会话 id → 状态）。
 * 子会话在问问题（status = waiting）时它自己的转录是空闲的，状态饼会画成「做完没看」——
 * 侧栏要靠这份把它画成「等你」（设计稿 1-entry-after：在问你的那件是橙点）。
 * 拉取口径与 useChannelSummaries 相同：父集合变了拉一遍，之后任一父的通道事件就重拉那一个。
 */
export function useChannelStatuses(parentIds: readonly string[]): ReadonlyMap<string, ChannelSummary["status"]> {
  const [byParent, setByParent] = useState<ReadonlyMap<string, readonly ChannelSummary[]>>(new Map());
  const key = [...parentIds].sort().join(",");
  useEffect(() => {
    const parents = key === "" ? [] : key.split(",");
    let cancelled = false;
    const refresh = (parentId: string): void => {
      void api.channel
        .list(parentId)
        .then((list) => {
          if (cancelled) return;
          setByParent((current) => new Map(current).set(parentId, list));
        })
        .catch((cause: unknown) => console.error("[channel] 通道列表读取失败", parentId, cause));
    };
    setByParent(new Map());
    parents.forEach(refresh);
    const off = api.channel.onEvent((event) => {
      if (parents.includes(event.parentId)) refresh(event.parentId);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [key]);
  const out = new Map<string, ChannelSummary["status"]>();
  for (const list of byParent.values()) for (const summary of list) out.set(summary.childId, summary.status);
  return out;
}
