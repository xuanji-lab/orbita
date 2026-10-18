/**
 * 自动更新的 contextBridge 面 —— 四层契约的第 3 层。
 *
 * 拉取是 invoke（get / check / download / cancel / install），状态是主进程推送
 * （updater:state，每次变化一份完整快照）。订阅方法名遵循 api.ts 的约定：`on` + 大写
 * 字母开头 = 同步返回退订函数，桥不在时替身能给出空退订。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { RecentReleasesResult, UpdaterSnapshot } from "../../shared/updater.ts";

export const updaterApi = {
  /** 当前快照（设置页挂载时一次；之后靠 onState 推送） */
  get: (): Promise<UpdaterSnapshot> => ipcRenderer.invoke(ipcChannels.updaterGet),
  /** 手动检查。失败不抛错：状态机会落到 error 态并把阶段带出来 */
  check: (): Promise<void> => ipcRenderer.invoke(ipcChannels.updaterCheck),
  /** 用户确认后开始下载（autoDownload=false） */
  download: (): Promise<void> => ipcRenderer.invoke(ipcChannels.updaterDownload),
  /** 取消正在进行的下载，退回 available */
  cancel: (): Promise<void> => ipcRenderer.invoke(ipcChannels.updaterCancel),
  /** 退出并安装已下载的更新（主进程先收掉 agent 进程，再 quitAndInstall） */
  install: (): Promise<void> => ipcRenderer.invoke(ipcChannels.updaterInstall),
  /** 「所有版本」展开体的最近版本列表（主进程打 GitHub API + 10 分钟缓存；失败是回执里的 ok:false，不抛错） */
  recentReleases: (): Promise<RecentReleasesResult> => ipcRenderer.invoke(ipcChannels.updaterRecentReleases),
  onState: (listener: (snapshot: UpdaterSnapshot) => void): (() => void) => {
    const handler = (_e: unknown, snapshot: UpdaterSnapshot) => listener(snapshot);
    ipcRenderer.on(ipcChannels.updaterState, handler);
    return () => ipcRenderer.removeListener(ipcChannels.updaterState, handler);
  },
};
