/**
 * 工作区的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";

export const workspaceApi = {
  /** 当前工作区路径（没选过则是 home） */
  current: (): Promise<string> => ipcRenderer.invoke(ipcChannels.workspaceCurrent),
  /** 没有选定工作区时 agent 落在哪儿（今天是 home）——UI 要如实显示这个兜底 */
  default: (): Promise<string> => ipcRenderer.invoke(ipcChannels.workspaceDefault),
  /** 打开原生目录选择器；取消返回 null */
  choose: (): Promise<string | null> => ipcRenderer.invoke(ipcChannels.workspaceChoose),
};
