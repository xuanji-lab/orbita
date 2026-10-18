/**
 * 自动更新的 IPC —— 四层契约的第 2 层。
 *
 * 五个通道（通道名与载荷形状见 shared/updater.ts）：get / check / download / cancel /
 * install。状态变化走 `updater:state` 广播，**只发给主窗口**：受管浏览器工具条那个
 * 窗口吃不到这条（它是一扇网页工具条，不含设置面）。
 *
 * 三个动作 handler 一律不抛错：失败已经进状态机（`error` 态带阶段），renderer 照状态画
 * 就行——让 invoke 再 reject 一次，界面就得写两套错误展示。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { mainWindows } from "../window/main-windows.ts";
import type { RecentReleases } from "./recent-releases.ts";
import type { Updater } from "./service.ts";

export function registerUpdaterIpc(updater: Updater, recentReleases: RecentReleases): void {
  ipcMain.handle(ipcChannels.updaterGet, () => updater.snapshot());
  ipcMain.handle(ipcChannels.updaterCheck, () => updater.check());
  ipcMain.handle(ipcChannels.updaterDownload, () => updater.download());
  ipcMain.handle(ipcChannels.updaterCancel, () => updater.cancel());
  ipcMain.handle(ipcChannels.updaterInstall, () => updater.install());
  // 「所有版本」展开体点开时拉一次（主进程侧 10 分钟缓存，见 recent-releases.ts）；
  // 它是一次纯网络请求，与更新器接不接线无关——dev 下同样可用
  ipcMain.handle(ipcChannels.updaterRecentReleases, () => recentReleases.recent());

  updater.onChange((snapshot) => {
    for (const window of mainWindows.list()) {
      window.webContents.send(ipcChannels.updaterState, snapshot);
    }
  });
}
