/**
 * 后台任务状态位的数据钩子：每次渲染现算「这一刻后台有什么」（background-strip.ts 的纯函数），
 * 再用逐字段比较挡掉没变化的结果——返回值引用只在真有变化时才换。状态位是 memo 组件，
 * 流式输出时 ChatView 每个 token 都渲染一遍，它拿到的仍是同一个数组引用，所以不重画。
 *
 * 这里只读**汇总状态**（通道摘要、引擎的 phase / 审批数、自动化列表）；只有存在失败的子会话时才多读
 * 一点母会话的槽（phase、投递痕迹、最新助手消息的时间——failureDigested 的原料）。
 * 「当前在做哪一步」那种要扫转录的活留给组件自己的 1 秒时钟。
 */
import { useMemo, useRef } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import { childSessions, type SessionMeta } from "@shared/session";
import type { ChannelMessage, ChannelSummary } from "@shared/channel";
import { useAutomationUi } from "../automation/automation-context.ts";
import {
  backgroundItems,
  failureDigested,
  parentFactsFrom,
  sameBgItems,
  type BgItem,
  type ParentFacts,
} from "./background-strip.ts";
import type { SessionEntry } from "./session-states.ts";

const NONE: readonly BgItem[] = [];

/** 母会话槽 → failureDigested 要的事实。读不到槽 = null（按没处理算） */
function parentFactsOf(entry: SessionEntry | undefined): ParentFacts | null {
  if (entry === undefined) return null;
  return parentFactsFrom({
    phase: entry.phase,
    marks: entry.marks,
    hasMore: entry.window.hasMore,
    items: selectTranscript(entry.transcript),
  });
}

export function useBackgroundItems(input: {
  /** 看着的会话 id；不该显示状态位（首页 / 子会话视图 / 面板内查看）传 null */
  parentId: string | null;
  sessions: readonly SessionMeta[];
  summaries: ReadonlyMap<string, ChannelSummary>;
  /** 各子通道的全文（失败回报的 id / 时刻从这里取） */
  channels: ReadonlyMap<string, readonly ChannelMessage[]>;
  phaseOf: (id: string) => string;
  approvalsOf: (id: string) => readonly unknown[];
  entryOf: (id: string) => SessionEntry | undefined;
}): readonly BgItem[] {
  const { parentId, sessions, summaries, channels, phaseOf, approvalsOf, entryOf } = input;
  const { automations } = useAutomationUi();
  const children = useMemo(
    () => (parentId === null ? [] : childSessions(sessions, parentId)),
    [parentId, sessions],
  );
  const previous = useRef<readonly BgItem[]>(NONE);
  if (parentId === null) {
    previous.current = NONE;
    return NONE;
  }
  // 母会话的事实只在真有失败项要判时才读（selectTranscript 要过一遍转录，不在每个 token 上白算）
  let parentFacts: ParentFacts | null | undefined;
  const next = backgroundItems({
    parentId,
    children,
    channelOf: (childId) => summaries.get(childId),
    probe: { approvalCountOf: (id) => approvalsOf(id).length, phaseOf },
    automations,
    failureDigested: (childId) => {
      parentFacts ??= parentFactsOf(entryOf(parentId));
      const messages = channels.get(childId);
      const failed = messages?.findLast((message) => message.kind === "failed") ?? null;
      return failureDigested({
        failed: failed === null ? null : { id: failed.id, at: failed.createdAt },
        fallbackAt: summaries.get(childId)?.lastAt ?? 0,
        messagesLoaded: messages !== undefined,
        parent: parentFacts,
      });
    },
    now: Date.now(),
  });
  if (!sameBgItems(previous.current, next)) previous.current = next;
  return previous.current;
}
