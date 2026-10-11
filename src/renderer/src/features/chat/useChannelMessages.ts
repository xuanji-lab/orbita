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

/**
 * 一条根会话下**全部子通道的全文**（收件箱与父流问询胶囊共用，2026-10-12）：
 * key 是 childId、值是该通道时间正序的全部消息。父流里的通道标记只有 messageId
 * （正文在通道账本），问询胶囊要按它取回正文首行；Sub-sessions 面板的收件箱行
 * 要按 childId 取「最新一句」。一次拉全部分小的通道文件（一对父子的往来本来就
 * 短），事件到达时按 childId 追加、按 id 去重——与 `useChannelMessages` 同一条
 * 纪律，只是通道数从 1 变 N。
 *
 * `childIds` 用逗号拼成字符串再进 effect 依赖：调用方每次渲染重建数组不该触发
 * N 份账本重拉（子会话清单只在真的增删时变化）。
 */
export function useParentChannels(
  parentId: string | null,
  childIds: readonly string[],
): ReadonlyMap<string, readonly ChannelMessage[]> {
  const childKey = childIds.join(",");
  const [channels, setChannels] = useState<ReadonlyMap<string, readonly ChannelMessage[]>>(new Map());

  useEffect(() => {
    if (parentId === null || childKey === "") {
      setChannels(new Map());
      return;
    }
    const ids = childKey.split(",");
    let cancelled = false;
    // 逐条拉而不是并发 `Promise.all` 后统一 set：先到先画，慢通道不拖住快通道
    const loads = ids.map((childId) =>
      api.channel
        .load({ parentId, childId })
        .then((list) => {
          if (cancelled) return;
          setChannels((prev) => new Map(prev).set(childId, sortChannelMessages(list)));
        })
        .catch((cause: unknown) => {
          // 错误不吞：打到控制台；这一条通道缺席，其余照常（收件箱行退回「还没说话」）
          console.error("[channel] 通道全文读取失败", { parentId, childId }, cause);
        }),
    );
    const off = api.channel.onEvent((event) => {
      if (event.type !== "message" || event.parentId !== parentId) return;
      setChannels((prev) => {
        const current = prev.get(event.childId);
        if (current !== undefined && current.some((m) => m.id === event.message.id)) return prev;
        return new Map(prev).set(event.childId, sortChannelMessages([...(current ?? []), event.message]));
      });
    });
    return () => {
      cancelled = true;
      off();
      void loads;
    };
  }, [parentId, childKey]);

  return channels;
}
