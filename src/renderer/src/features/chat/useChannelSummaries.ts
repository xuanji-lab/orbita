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

/** 摘要与它的归属：`loadedFor` 等于当前 parentId 才说明这份摘要是这个父的、而且已经取回来了 */
export interface ChannelSummariesState {
  summaries: ReadonlyMap<string, ChannelSummary>;
  loadedFor: string | null;
}

const EMPTY: ReadonlyMap<string, ChannelSummary> = new Map();

/**
 * 带「取回来没有」的版本。以前只回一张 Map：刚挂载（或父会话刚换）时它是空的 / 还是上一个父的，
 * 调用方分不清「这条子会话没有通道」与「还没取回来」——子会话面板把后者当成「通道还开着」，
 * 于是每次切会话都把全部子会话的转录整份读一遍（实验分支：切换会话卡顿的根因之一）。
 */
export function useChannelSummariesState(parentId: string | null): ChannelSummariesState {
  const [state, setState] = useState<ChannelSummariesState>({ summaries: EMPTY, loadedFor: null });

  useEffect(() => {
    if (parentId === null) {
      setState({ summaries: EMPTY, loadedFor: null });
      return;
    }
    let cancelled = false;
    const refresh = (): void => {
      void api.channel
        .list(parentId)
        .then((list) => {
          if (cancelled) return;
          setState({ summaries: new Map(list.map((summary) => [summary.childId, summary])), loadedFor: parentId });
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

  // 父会话刚换、新的还没取回来：不拿上一个父的摘要充数
  return state.loadedFor === parentId ? state : { summaries: EMPTY, loadedFor: null };
}

export function useChannelSummaries(parentId: string | null): ReadonlyMap<string, ChannelSummary> {
  return useChannelSummariesState(parentId).summaries;
}
