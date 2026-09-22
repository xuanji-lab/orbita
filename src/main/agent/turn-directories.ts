/**
 * 开轮目录清单的装配（2026-09-22 裁决）：把 `AgentTurnContext` 里的 workspaceId /
 * sessionId 翻成 `TurnDirectories`。**纯模块**（store 注入），可被 `node --test` 直接测
 * ——ipc.ts import electron，逻辑放那里就没法直接测（write-requests.ts 的同款先例）。
 *
 * **装配在主进程**（同 skillsDirs / protectedPaths 的纪律）：附加目录是工作区记录里
 * 的事实，agent 进程不该自己去读工作区文件；工作台路径由 session id 派生。每轮现读
 * 现装配，工作区挂新目录、换附加目录，下一轮即生效。
 */
import type { TurnDirectories } from "../../shared/agent-ipc.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";

export async function resolveTurnDirectories(
  workspaces: WorkspaceStore,
  sessions: SessionStore,
  turn: { sessionId: string; workspaceId: string | null },
): Promise<TurnDirectories> {
  // Home 会话（workspaceId null）不用查表——它没有附加目录，省一次读盘
  const attached =
    turn.workspaceId === null
      ? []
      : ((await workspaces.list()).find((w) => w.id === turn.workspaceId)?.attachedDirs ?? []);
  // 工作区被删了（meta 还指着旧 id）按「没有附加目录」处理：会话落到 TASKS 是
  // 已有语义，开轮不该因为一个不存在的 workspaceId 失败
  return { attached, workbench: sessions.workbenchPath(turn.sessionId) };
}
