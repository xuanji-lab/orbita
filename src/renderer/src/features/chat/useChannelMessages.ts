/**
 * 单个通道的全文（子会话 PR4b）——通道卡展开时消费。与 `useChannelSummaries`
 * 同一条纪律：读不出来打到控制台、不吞，界面显示一行错误态（brief 3.1）。
 *
 * 与 `useChannelSummaries` 的不同：那个 hook 每次事件都整份重拉（通道数量小，
 * 简单可靠优先）；这里的账本可能已经不短（一条通道的全部往来），子→父/父→子
 * 消息实时到达是高频事件，`type === "message"` 且 parentId/childId 匹配时**追加**
 * 这条消息（按 id 去重）而不是重拉一遍。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { sortChannelMessages, type ChannelKey, type ChannelMessage } from "@shared/channel";

export interface ChannelMessagesState {
  messages: readonly ChannelMessage[];
  /** 首次 load 进行中；追加消息不走这个态——只有整份重拉才算「在加载」 */
  loading: boolean;
  /** load 失败的原因；不为 null 时界面显示一行错误态，不吞 */
  error: string | null;
}

const EMPTY_STATE: ChannelMessagesState = { messages: [], loading: false, error: null };

export function useChannelMessages(key: ChannelKey | null): ChannelMessagesState {
  const [state, setState] = useState<ChannelMessagesState>(EMPTY_STATE);
  const parentId = key?.parentId ?? null;
  const childId = key?.childId ?? null;

  useEffect(() => {
    if (parentId === null || childId === null) {
      setState(EMPTY_STATE);
      return;
    }
    const target: ChannelKey = { parentId, childId };
    let cancelled = false;
    setState({ messages: [], loading: true, error: null });
    void api.channel
      .load(target)
      .then((list) => {
        if (cancelled) return;
        setState({ messages: sortChannelMessages(list), loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 错误不吞：读不出来打到控制台，界面另有一行错误态（ChannelColumn 消费 error 字段）
        console.error("[channel] 通道全文读取失败", target, cause);
        setState({ messages: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) });
      });
    const off = api.channel.onEvent((event) => {
      if (event.type !== "message") return;
      if (event.parentId !== target.parentId || event.childId !== target.childId) return;
      setState((prev) => {
        // 按 id 去重：订阅重连等场景可能让同一条消息重复到达
        if (prev.messages.some((m) => m.id === event.message.id)) return prev;
        return { ...prev, messages: sortChannelMessages([...prev.messages, event.message]) };
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [parentId, childId]);

  return state;
}
