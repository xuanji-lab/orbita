/**
 * 开轮目录清单的装配（2026-09-22 裁决，2026-09-23 加子会话互见）：把
 * `AgentTurnContext` 里的 workspaceId / sessionId 翻成 `TurnDirectories`。
 * **纯模块**（store 注入），可被 `node --test` 直接测——ipc.ts import electron，
 * 逻辑放那里就没法直接测（write-requests.ts 的同款先例）。
 *
 * **装配在主进程**（同 skillsDirs / protectedPaths 的纪律）：附加目录是工作区记录里
 * 的事实，agent 进程不该自己去读工作区文件；工作台路径由 session id 派生。每轮现读
 * 现装配，工作区挂新目录、换附加目录，下一轮即生效。
 */
import type { ChannelStatus } from "../../shared/channel.ts";
import { isSessionDone, type SessionMeta } from "../../shared/session.ts";
import type { TurnDirectories } from "../../shared/agent-ipc.ts";
import type { ChannelStore } from "../channel/store.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";

export async function resolveTurnDirectories(
  workspaces: WorkspaceStore,
  sessions: SessionStore,
  channels: ChannelStore,
  turn: { sessionId: string; workspaceId: string | null },
): Promise<TurnDirectories> {
  // attachedDirsOf 是唯一入口：null → Home 的清单（Home 也能挂），悬空 id → []——
  // 会话落到 TASKS 是既有语义，开轮不该因为一个不存在的 workspaceId 失败
  const attached = await workspaces.attachedDirsOf(turn.workspaceId);
  const workbench = sessions.workbenchPath(turn.sessionId);

  // 父子会话互见对方的工作台（子会话 2026-09-23 裁决，2026-09-23 加 sessionId/relation）：
  // 只告知不硬拦，related 缺席 = 没有父子关系（绝大多数会话）。relation 是**对方**相对
  // 本会话的角色——runtime 靠它判断本会话是不是子会话（决定注册哪些通道工具）。
  // 子会话行是父会话的**派发台账**（2026-10-19 裁决）：带通道状态（status 只给子——
  // 「它对我交付过没有」决定还能不能把新活派给它），completion 已翻 done / done_with_todos
  // 的不再列出（判据复用 isSessionDone，不另写一份），最多留最近 8 条——按最后活动
  // 倒序截断，更早的在台账里消失即可，归档与会话删除负责真正收尾。
  const related: {
    sessionId: string;
    relation: "parent" | "child";
    label: string;
    path: string;
    status?: ChannelStatus;
  }[] = [];
  const meta = await sessions.readMeta(turn.sessionId);
  const parentId = meta?.parentId;
  if (parentId !== undefined) {
    const parent = await sessions.readMeta(parentId);
    related.push({
      sessionId: parentId,
      relation: "parent",
      label: parent === null || parent.title === "" ? "Parent session" : parent.title,
      path: sessions.workbenchPath(parentId),
    });
  }
  // 每个 orbita 派出的子都有通道文件；根会话目录不存在 → []，比每轮 sessions.list()
  // 读全部 meta 便宜。标题与归档判定共用同一次 readMeta（titleOf 的缓存），免得每个
  // 子会话读两遍盘。
  const childMetaById = new Map<string, SessionMeta | null>();
  const children = await channels.listForParent(turn.sessionId, async (childId) => {
    const child = await sessions.readMeta(childId);
    childMetaById.set(childId, child);
    return child?.title ?? "";
  });
  // 先剔除已完成的，再按倒序截 8 条：留下的是「最近活跃且还没交付完结」的台账。
  const childEntries = children
    .filter((child) => {
      const childMeta = childMetaById.get(child.childId) ?? null;
      return childMeta === null || !isSessionDone(childMeta);
    })
    .slice(0, 8)
    .map((child) => ({
      sessionId: child.childId,
      relation: "child" as const,
      label: child.childTitle === "" ? "Sub-session" : child.childTitle,
      path: sessions.workbenchPath(child.childId),
      status: child.status,
    }));
  related.push(...childEntries);

  return { attached, workbench, ...(related.length > 0 ? { related } : {}) };
}
