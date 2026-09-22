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
  /** 命名新建：在 ~/Orbita/<name>/ 建文件夹并加为工作区。同名文件夹已存在就直接加它（不覆盖、不报错） */
  create: (name: string): Promise<Workspace> => ipcRenderer.invoke(ipcChannels.workspaceCreate, name),
  rename: (id: string, name: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.workspaceRename, id, name),
  /** 移出列表；**不动磁盘上的文件夹，也不删它的会话** */
  remove: (id: string): Promise<void> => ipcRenderer.invoke(ipcChannels.workspaceRemove, id),
  /** 没有选定工作区时 agent 落在哪儿（今天是 ~/Orbita/Home）——UI 要如实显示这个兜底 */
  default: (): Promise<string> => ipcRenderer.invoke(ipcChannels.workspaceDefault),
  /** 打开原生目录选择器，把选中目录挂进工作区的 attachedDirs；取消返回 null，重复挂不重复 */
  attachDir: (id: string): Promise<Workspace | null> =>
    ipcRenderer.invoke(ipcChannels.workspaceAttachDir, id),
  /** 从 attachedDirs 摘掉一条（幂等，不在列表里不报错），返回更新后的工作区 */
  detachDir: (id: string, dir: string): Promise<Workspace> =>
    ipcRenderer.invoke(ipcChannels.workspaceDetachDir, id, dir),
};
