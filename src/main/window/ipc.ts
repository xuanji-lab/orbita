/**
 * 窗口域 IPC —— 四层契约的第 2 层。
 *
 * Windows/Linux 转帧式窗口后，最小化 / 最大化 / 关闭由渲染层标题栏自绘；
 * 这里只做「把命令落到发起请求的那扇窗口上」。窗口从事件发送方反推——
 * 永远不会有第二扇可操作的窗口，也就不需要传窗口 id。
 */
import { BrowserWindow, ipcMain } from "electron";
import { windowChannels } from "../../shared/window.ts";

export function registerWindowIpc(): void {
  const of = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle(windowChannels.windowMinimize, (event) => {
    of(event)?.minimize();
  });

  // 最大化 / 还原二合一：按钮只有一个，按当前状态切换
  ipcMain.handle(windowChannels.windowToggleMaximize, (event) => {
    const window = of(event);
    if (window === null) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });

  ipcMain.handle(windowChannels.windowClose, (event) => {
    of(event)?.close();
  });
}
