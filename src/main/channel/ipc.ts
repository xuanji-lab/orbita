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
import type { StartupClosureQueue } from "./startup-closures.ts";

export function registerChannelIpc(deps: ChannelDeps, startup: StartupClosureQueue): void {
  ipcMain.handle(ipcChannels.channelList, async (_e, parentId: string) => {
    const list = await deps.channels.listForParent(parentId, async (childId) => (await deps.sessions.readMeta(childId))?.title ?? "");
    // 启动收尾在首屏后台跑（startup-closures.ts）。父会话第一次要摘要时补播已完成的那些，
    // 让 #553 的待讨论 / 交回提示走现有消息路由；还没完成的，完成那一刻直接播给它。
    startup.listed(parentId);
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

/** 启动收尾通知的广播形态（channel:list 补播与收尾完成时直接播共用） */
export function broadcastClosureNotices(deps: Pick<ChannelDeps, "broadcast">, notices: readonly ChannelClosureNotice[]): void {
  // 放到下一拍：list 的回执先到 renderer，再来增量事件（原补播同一时序）
  setTimeout(() => {
    for (const notice of notices) {
      deps.broadcast({ type: "message", parentId: notice.parentId, childId: notice.childId, message: notice.message, childWorkbench: notice.childWorkbench });
      deps.broadcast({ type: "status", parentId: notice.parentId, childId: notice.childId, status: notice.status });
    }
  }, 0);
}
