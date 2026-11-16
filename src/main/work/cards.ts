/**
 * 主智能体读小卡（work_cards）的主进程一侧：按它派出的每件活现算一张小卡（shared/work-card.ts），压成几行给模型。
 * 不翻子会话的原文给模型——只给小卡（那一句、几个勾、在等什么、有没有动静）。
 * 「最后一次动静」由 index.ts 的事件泵按会话记（progress 事件：新动作或命令新输出都会来一条），不落盘：
 * 重开应用后还没收到事件的活不算没动静（isQuiet 对未知时刻的口径）。
 */
import { channelStatus } from "../../shared/channel.ts";
import { childSessions, type SessionMeta, type SessionRecord } from "../../shared/session.ts";
import type { TranscriptItem } from "../../shared/transcript.ts";
import { workCardOf, workCardsText } from "../../shared/work-card.ts";
import type { ChannelStore } from "../channel/store.ts";
import type { SessionStore } from "../session/store.ts";

const isTranscriptItem = (record: SessionRecord): record is TranscriptItem =>
  record.role === "user" || record.role === "assistant" || record.role === "tool";

export async function workCardsFor(
  deps: {
    sessions: Pick<SessionStore, "list" | "load">;
    channels: Pick<ChannelStore, "load">;
    running: (sessionId: string) => boolean;
    lastActivityAt: (sessionId: string) => number | null;
  },
  parentId: string,
  now: number,
): Promise<string> {
  const children: SessionMeta[] = childSessions(await deps.sessions.list(), parentId);
  const cards = await Promise.all(
    children.map(async (child) => {
      const messages = await deps.channels.load({ parentId, childId: child.id });
      const detail = await deps.sessions.load(child.id);
      return workCardOf({
        meta: child,
        status: channelStatus(messages),
        messages,
        items: (detail?.transcript ?? []).filter(isTranscriptItem),
        running: deps.running(child.id),
        lastActivityAt: deps.lastActivityAt(child.id),
        now,
      });
    }),
  );
  return workCardsText(cards, now);
}
