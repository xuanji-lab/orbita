/**
 * 后台任务条的数据钩子：每次渲染现算「这一刻后台有什么」（background-strip.ts 的纯函数），
 * 再用逐字段比较挡掉没变化的结果——返回值引用只在真有变化时才换。条是 memo 组件，
 * 流式输出时 ChatView 每个 token 都渲染一遍，条拿到的仍是同一个数组引用，所以不重画。
 *
 * 这里只读**汇总状态**（通道摘要、引擎的 phase / 审批数、自动化列表），不碰转录——
 * 「当前在做哪一步」那种要扫转录的活留给条自己的 1 秒时钟（BackgroundStrip.tsx）。
 */
import { useMemo, useRef } from "react";
import { childSessions, type SessionMeta } from "@shared/session";
import type { ChannelSummary } from "@shared/channel";
import { useAutomationUi } from "../automation/automation-context.ts";
import { backgroundItems, sameBgItems, type BgItem } from "./background-strip.ts";

const NONE: readonly BgItem[] = [];

export function useBackgroundItems(input: {
  /** 看着的会话 id；不该显示条（首页 / 子会话视图 / 面板内查看）传 null */
  parentId: string | null;
  sessions: readonly SessionMeta[];
  summaries: ReadonlyMap<string, ChannelSummary>;
  phaseOf: (id: string) => string;
  approvalsOf: (id: string) => readonly unknown[];
}): readonly BgItem[] {
  const { parentId, sessions, summaries, phaseOf, approvalsOf } = input;
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
  const next = backgroundItems({
    parentId,
    children,
    channelOf: (childId) => summaries.get(childId),
    probe: { approvalCountOf: (id) => approvalsOf(id).length, phaseOf },
    automations,
    now: Date.now(),
  });
  if (!sameBgItems(previous.current, next)) previous.current = next;
  return previous.current;
}
