/**
 * 会话的 contextBridge 面 —— 四层契约的第 3 层。
 * 界面上叫 task，代码里叫 session（docs/ubiquitous-language.md）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels, type SessionWorkbenchStat } from "../../shared/agent-ipc.ts";
import type {
  Carryover,
  CarryoverDraft,
  CarryoverStatus,
  SessionCompletion,
  SessionDetail,
  SessionMeta,
} from "../../shared/session.ts";

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
  /** 工作台现状（路径 / 存不存在 / 递归文件数）。删除确认项吃它——先把后果说出来再删 */
  workbenchStat: (id: string): Promise<SessionWorkbenchStat> =>
    ipcRenderer.invoke(ipcChannels.sessionWorkbenchStat, id),
  pin: (id: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionPin, id, pinned),
  /** 星标：价值标记，与置顶正交——不置顶，只给侧栏标识与筛选 */
  star: (id: string, starred: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionStar, id, starred),
  /** 完成状态：done/done_with_todos 记关闭时刻；回 open（reopen）清空。纯 meta 操作，只读会话也可用 */
  setCompletion: (id: string, completion: SessionCompletion): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionSetCompletion, id, completion),
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
  // —— 遗留事项（收尾仪式）三通道 ——
  /** 全部遗留事项，落盘顺序。角标与筛选按 sourceSessionId 在 renderer 现算 */
  carryoverList: (): Promise<Carryover[]> => ipcRenderer.invoke(ipcChannels.carryoverList),
  /** 批量落盘（收尾仪式确认的那一拨）；返回铸好 id/status/时间戳的完整记录 */
  carryoverCreate: (sessionId: string, drafts: CarryoverDraft[]): Promise<Carryover[]> =>
    ipcRenderer.invoke(ipcChannels.carryoverCreate, sessionId, drafts),
  /** 翻转一条的状态：done 记 doneAt，回 open 清掉 */
  carryoverSetStatus: (id: string, status: CarryoverStatus): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.carryoverSetStatus, id, status),
};
