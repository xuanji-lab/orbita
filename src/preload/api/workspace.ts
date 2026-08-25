/**
 * 工作区的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { Workspace } from "../../shared/workspace.ts";

export const workspaceApi = {
  list: (): Promise<Workspace[]> => ipcRenderer.invoke(ipcChannels.workspaceList),
  /** 打开原生目录选择器并加为工作区；取消返回 null。同一路径重复加返回已有的那条。 */
  add: (): Promise<Workspace | null> => ipcRenderer.invoke(ipcChannels.workspaceAdd),
  rename: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.workspaceRename, id, name),
  /** 移出列表；**不动磁盘上的文件夹，也不删它的会话** */
  remove: (id: string): Promise<void> => ipcRenderer.invoke(ipcChannels.workspaceRemove, id),
  /** 没有选定工作区时 agent 落在哪儿（今天是 home）——UI 要如实显示这个兜底 */
  default: (): Promise<string> => ipcRenderer.invoke(ipcChannels.workspaceDefault),
};
