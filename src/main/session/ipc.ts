/**
 * 会话的 IPC —— 四层契约的第 2 层，外加一件只有主进程做得到的事：**记录**。
 *
 * agent 进程的事件本来就要经主进程转给窗口，落盘挂在这条路上是最短的一跳；
 * 而且职责上就该在这里——AGENTS.md：「主进程只负责窗口、IPC 与持久化」，
 * `runtime.ts` 自陈「不碰持久化路径策略」。
 */
import { ipcMain } from "electron";
import { ipcChannels, type AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionStore } from "./store.ts";

export function registerSessionIpc(store: SessionStore): void {
  ipcMain.handle(ipcChannels.sessionList, () => store.list());
  ipcMain.handle(ipcChannels.sessionLoad, (_event, id: string) => store.load(id));
  ipcMain.handle(ipcChannels.sessionDelete, (_event, id: string) => store.remove(id));
}

/**
 * agent 事件 → 落盘。**只认两个终态帧**：
 *
 *   assistant  `item_finished`  —— message_end 时 adapter 发的终态帧
 *   user       `item_started`   —— 用户消息出生即完成，adapter 不会再给它发 finished
 *
 * 中途 abort 的半截 assistant 消息因此不落盘。这是刻意的：只存完成了的，
 * 免得重开会话时看到一句被截断的话，还以为模型当时就是这么说的。
 *
 * **不做归约。** 归约是渲染层的事（用 pi 自带的归约器），这里只挑终态帧，
 * 所以主进程里没有第二份归约逻辑（guideline §三）。
 */
export function createSessionRecorder(store: SessionStore): (event: AgentEvent) => void {
  return (event) => {
    if (event.type !== "progress") return;
    const progress = event.progress;
    const item =
      progress.type === "item_finished"
        ? progress.item
        : progress.type === "item_started" && progress.item.role === "user"
          ? progress.item
          : null;
    if (item === null) return;
    // 写失败不该让对话中断——记一条日志，界面照常
    void store.record(event.sessionId, item).catch((error: unknown) => {
      console.error("[session] 落盘失败", event.sessionId, error);
    });
  };
}
