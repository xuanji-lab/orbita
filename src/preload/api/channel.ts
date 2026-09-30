/**
 * 通道域的 contextBridge 面 —— 四层契约的第 3 层。
 * 只依赖 electron 与 src/shared。消费者：通道面板（代父发言 composer）与
 * Sub-sessions 面板会话层（终止入口）。
 */
import { ipcRenderer } from "electron";
import {
  ipcChannels,
  type ChannelEvent,
  type ChannelSpeakInput,
  type ChannelStopInput,
} from "../../shared/agent-ipc.ts";
import type { ChannelKey, ChannelMessage, ChannelSummary } from "../../shared/channel.ts";

export const channelApi = {
  /** 父会话的通道列表（只含 hasExchange 或 running 的，由主进程按账本现算） */
  list: (parentId: string): Promise<ChannelSummary[]> => ipcRenderer.invoke(ipcChannels.channelList, parentId),
  /** 读一份通道账本全文，时间正序 */
  load: (key: ChannelKey): Promise<ChannelMessage[]> => ipcRenderer.invoke(ipcChannels.channelLoad, key),
  /** 用户在通道里代父发言 */
  speak: (input: ChannelSpeakInput): Promise<ChannelMessage> => ipcRenderer.invoke(ipcChannels.channelSpeak, input),
  /** 用户终止一个子会话（中止在跑的轮 + 结掉挂着的浏览器交接 + 账本落 stop） */
  stop: (input: ChannelStopInput): Promise<void> => ipcRenderer.invoke(ipcChannels.channelStop, input),
  onEvent: (listener: (event: ChannelEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: ChannelEvent) => listener(event);
    ipcRenderer.on(ipcChannels.channelEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.channelEvent, handler);
  },
};
