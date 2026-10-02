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

export function registerChannelIpc(deps: ChannelDeps): void {
  ipcMain.handle(ipcChannels.channelList, (_e, parentId: string) =>
    deps.channels.listForParent(parentId, async (childId) => (await deps.sessions.readMeta(childId))?.title ?? ""),
  );
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
