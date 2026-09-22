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

  // 父子会话互见对方的工作台（子会话 2026-09-23 裁决）：只告知不硬拦，
  // related 缺席 = 没有父子关系（绝大多数会话）。
  const related: { label: string; path: string }[] = [];
  const meta = await sessions.readMeta(turn.sessionId);
  const parentId = meta?.parentId;
  if (parentId !== undefined) {
    const parent = await sessions.readMeta(parentId);
    related.push({
      label: parent === null || parent.title === "" ? "Parent session" : parent.title,
      path: sessions.workbenchPath(parentId),
    });
  }
  // 每个 orbita 派出的子都有通道文件；根会话目录不存在 → []，比每轮 sessions.list()
  // 读全部 meta 便宜。
  const children = await channels.listForParent(turn.sessionId, async (childId) => {
    const child = await sessions.readMeta(childId);
    return child?.title ?? "";
  });
  for (const child of children) {
    related.push({
      label: child.childTitle === "" ? "Sub-session" : child.childTitle,
      path: sessions.workbenchPath(child.childId),
    });
  }

  return { attached, workbench, ...(related.length > 0 ? { related } : {}) };
}
