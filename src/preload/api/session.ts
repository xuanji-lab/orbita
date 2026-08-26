/**
 * 会话的 contextBridge 面 —— 四层契约的第 3 层。
 * 界面上叫 task，代码里叫 session（docs/ubiquitous-language.md）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { SessionDetail, SessionMeta } from "../../shared/session.ts";

export const sessionApi = {
  /** 会话列表，新的在前 */
  list: (): Promise<SessionMeta[]> => ipcRenderer.invoke(ipcChannels.sessionList),
  /** 读一条会话的元数据与 transcript；不存在返回 null */
  load: (id: string): Promise<SessionDetail | null> =>
    ipcRenderer.invoke(ipcChannels.sessionLoad, id),
  /** 改名；空名字会退回从第一条用户消息推导 */
  rename: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionRename, id, title),
  remove: (id: string): Promise<void> => ipcRenderer.invoke(ipcChannels.sessionDelete, id),
};
