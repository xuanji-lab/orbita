/**
 * 会话的 contextBridge 面 —— 四层契约的第 3 层。
 * 界面上叫 task，代码里叫 session（docs/ubiquitous-language.md）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels, type SessionWorkbenchStat } from "../../shared/agent-ipc.ts";
import type { PromptImage } from "../../shared/prompt-images.ts";
import type { RevertPlan, UndoPlan } from "../../shared/revert.ts";
import type {
  ModelAssignEntry,
  ModelAssignGroups,
  ModelAssignRunResult,
} from "../../shared/model-assign.ts";
import type { WrapupConfirmInput, WrapupPlan, WrapupReviseInput, WrapupReviseResult } from "../../shared/wrapup.ts";
import type {
  Carryover,
  CarryoverStatus,
  SessionCompletion,
  SessionMeta,
  SessionMoveResult,
  SessionOlderPage,
  SessionWindowDetail,
} from "../../shared/session.ts";

export const sessionApi = {
  /** 会话列表，新的在前 */
  list: (): Promise<SessionMeta[]> => ipcRenderer.invoke(ipcChannels.sessionList),
  /** 读一条会话的元数据与 transcript；不存在返回 null */
  load: (id: string): Promise<SessionWindowDetail | null> =>
    ipcRenderer.invoke(ipcChannels.sessionLoad, id),
  /**
   * 已加载窗口之前的一页（滚动触顶时拉）。before = 窗口第一条记录的 id（缺了 / 对不上
   * 盘上的世界就回空页），limit = 想要的条数，主进程会夹在有效区间
   */
  loadOlder: (id: string, before: string, limit: number): Promise<SessionOlderPage> =>
    ipcRenderer.invoke(ipcChannels.sessionLoadOlder, id, before, limit),
  /** 改名；空名字会退回从第一条用户消息推导 */
  rename: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionRename, id, title),
  remove: (id: string): Promise<void> => ipcRenderer.invoke(ipcChannels.sessionDelete, id),
  // —— 给导入的会话分配模型（设置 › 服务商） ——
  /** 还挂着占位 provider 的会话按原模型名分组（只读）；提示行与预览都吃它 */
  modelAssignGroups: (): Promise<ModelAssignGroups> => ipcRenderer.invoke(ipcChannels.modelAssignGroups),
  /** 按「原模型名 → 目标」清单执行；目标失效以错误 reject（稳定错误码），期间被改过的会话跳过 */
  modelAssignRun: (entries: ModelAssignEntry[]): Promise<ModelAssignRunResult> =>
    ipcRenderer.invoke(ipcChannels.modelAssignRun, entries),
  /** 工作台现状（路径 / 存不存在 / 递归文件数）。删除确认项吃它——先把后果说出来再删 */
  workbenchStat: (id: string): Promise<SessionWorkbenchStat> =>
    ipcRenderer.invoke(ipcChannels.sessionWorkbenchStat, id),
  /** 按转录图块上的 original 引用读原图；null = 没有原图可看，退回缩放图 */
  attachment: (ref: string): Promise<PromptImage | null> =>
    ipcRenderer.invoke(ipcChannels.sessionAttachment, ref),
  pin: (id: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionPin, id, pinned),
  /** 星标：价值标记，与置顶正交——不置顶，只给侧栏标识与筛选 */
  star: (id: string, starred: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionStar, id, starred),
  /** 完成状态：done/done_with_todos 记关闭时刻；回 open（reopen）清空。纯 meta 操作，只读会话也可用 */
  setCompletion: (id: string, completion: SessionCompletion): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionSetCompletion, id, completion),
  /** 意图召回的会话级开关（实验功能 intent-system）：只落 meta，下一轮生效 */
  setIntentEnabled: (id: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionSetIntentEnabled, id, enabled),
  /**
   * 未读标记（后台跑完还没看）：标 `{ at, failed }`，null 清。落盘后重启仍在；
   * 侧栏竖条与铃铛清单都读 meta 上的它，不各存一份
   */
  setUnread: (id: string, unread: { at: number; failed: boolean } | null): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionUnread, id, unread),
  /** 归档：从主列表移走，**不是删除** */
  archive: (id: string, archived: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionArchive, id, archived),
  /** 迁移到另一个工作区（可批量；归属与 cwd 一起换，子会话跟着走，在跑的跳过）；null = 回到 TASKS */
  move: (ids: readonly string[], workspaceId: string | null): Promise<SessionMoveResult> =>
    ipcRenderer.invoke(ipcChannels.sessionMove, ids, workspaceId),
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
  // —— 收尾（shared/wrapup.ts）三通道 ——
  /** 这次要扫的轮次与各轮用量；会话不存在 / 没有新轮次 null */
  wrapupPlan: (id: string): Promise<WrapupPlan | null> => ipcRenderer.invoke(ipcChannels.sessionWrapupPlan, id),
  /** 按用户一句话改清单（家务活模型一次独立小调用，不进会话） */
  wrapupRevise: (id: string, input: WrapupReviseInput): Promise<WrapupReviseResult> =>
    ipcRenderer.invoke(ipcChannels.sessionWrapupRevise, id, input),
  /** 确认：做完的事落账、留下的事进遗留清单、会话标完成、接着做的遗留事项标做完 */
  wrapupConfirm: (id: string, input: WrapupConfirmInput): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionWrapupConfirm, id, input),
  /** 翻转一条的状态：done 记 doneAt，回 open 清掉 */
  carryoverSetStatus: (id: string, status: CarryoverStatus): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.carryoverSetStatus, id, status),
  // —— 会话回退 / 单轮撤销（revert.ts）四通道 + 轮尾产物打开两通道 ——
  /** 回退计划（确认框列清单用）：目标消息及之后会被撤回什么 */
  revertPlan: (id: string, targetMessageId: string): Promise<RevertPlan> =>
    ipcRenderer.invoke(ipcChannels.sessionRevertPlan, id, targetMessageId),
  /** 执行回退：对话撤回、pi 本子裁枝、文件还原到快照；返回后重读会话即得新画面 */
  revert: (id: string, targetMessageId: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionRevert, id, targetMessageId),
  /** 撤销计划（确认框列清单用）：这一轮的文件会被还原成什么 */
  undoPlan: (id: string, turnId: string): Promise<UndoPlan> =>
    ipcRenderer.invoke(ipcChannels.sessionUndoPlan, id, turnId),
  /** 执行单轮撤销：只还原这一轮的文件，pi 本子追加一条告知模型 */
  undo: (id: string, turnId: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionUndo, id, turnId),
  /** 轮尾产物在内置浏览器打开（仅会话文件账里的网页文件） */
  openArtifactInBrowser: (id: string, path: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionOpenArtifactInBrowser, id, path),
  /** 轮尾产物在系统文件管理器里定位（仅会话文件账里记过的文件） */
  revealArtifact: (id: string, path: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.sessionRevealArtifact, id, path),
};
