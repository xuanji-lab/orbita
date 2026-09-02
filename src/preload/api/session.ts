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
  pin: (id: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionPin, id, pinned),
  /** 归档：从主列表移走，**不是删除** */
  archive: (id: string, archived: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionArchive, id, archived),
  /** 换归属工作区；null = 回到 TASKS */
  move: (id: string, workspaceId: string | null): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionMove, id, workspaceId),
  /**
   * 从某条 agent 回答另起一支（C-2）：新会话 = 该回答及之前的全部，原会话不动。
   * 返回新会话 id；两本账对不上时以错误拒绝（宁可不分支，不切错位置）。
   */
  branch: (id: string, anchorItemId: string): Promise<string> =>
    ipcRenderer.invoke(ipcChannels.sessionBranch, id, anchorItemId),
  /** 导出成 Markdown，走原生保存对话框；取消返回 null，否则返回落盘路径 */
  exportMarkdown: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(ipcChannels.sessionExport, id),
};
