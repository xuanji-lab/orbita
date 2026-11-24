/**
 * 通道的 IPC —— 四层契约的第 2 层。
 * `channel:speak` 落到 `applySpeak`、`channel:stop` 落到 `applyStop`（都在 requests.ts）；
 * list/load 直接读 ChannelStore，不经过 requests.ts 的入口（它们是模型/用户发消息的
 * 路径，list/load 只读）。
 */
import { ipcMain } from "electron";
import { mainWindows } from "../window/main-windows.ts";
import {
  ipcChannels,
  type ChannelEvent,
  type ChannelSpeakInput,
  type ChannelStopInput,
} from "../../shared/agent-ipc.ts";
import type { ChannelKey } from "../../shared/channel.ts";
import { applySpeak, applyStop, type ChannelDeps } from "./requests.ts";
import type { ChannelClosureNotice } from "./reconcile.ts";

export function registerChannelIpc(deps: ChannelDeps, startupNotices: ChannelClosureNotice[] = []): void {
  ipcMain.handle(ipcChannels.channelList, async (_e, parentId: string) => {
    const list = await deps.channels.listForParent(parentId, async (childId) => (await deps.sessions.readMeta(childId))?.title ?? "");
    // 启动收尾发生在 renderer 订阅之前。父会话第一次要摘要时补播一次，让 #553 的
    // 待讨论 / 交回提示走现有消息路由；不会在每次重拉时重复开一轮。
    const due = startupNotices.filter((notice) => notice.parentId === parentId);
    if (due.length > 0) {
      for (const notice of due) startupNotices.splice(startupNotices.indexOf(notice), 1);
      setTimeout(() => {
        for (const notice of due) {
          deps.broadcast({
            type: "message",
            parentId: notice.parentId,
            childId: notice.childId,
            message: notice.message,
            childWorkbench: notice.childWorkbench,
          });
          deps.broadcast({
            type: "status",
            parentId: notice.parentId,
            childId: notice.childId,
            status: notice.status,
          });
        }
      }, 0);
    }
    return list;
  });
  ipcMain.handle(ipcChannels.channelLoad, (_e, key: ChannelKey) => deps.channels.load(key));
  ipcMain.handle(ipcChannels.channelSpeak, (_e, input: ChannelSpeakInput) => applySpeak(deps, input));
  ipcMain.handle(ipcChannels.channelStop, (_e, input: ChannelStopInput) => applyStop(deps, input));
}

/** 主进程 → 所有主窗口，同 agent/ipc.ts 的 broadcastAgentEvent 形态 */
export function broadcastChannelEvent(event: ChannelEvent): void {
  for (const window of mainWindows.list()) {
    window.webContents.send(ipcChannels.channelEvent, event);
  }
}
