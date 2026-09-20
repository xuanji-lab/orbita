/**
 * 窗口域 IPC —— 四层契约的第 2 层。
 *
 * Windows/Linux 转帧式窗口后，最小化 / 最大化 / 关闭由渲染层标题栏自绘；
 * 这里只做「把命令落到发起请求的那扇窗口上」。窗口从事件发送方反推——
 * 永远不会有第二扇可操作的窗口，也就不需要传窗口 id。
 */
import { BrowserWindow, ipcMain, systemPreferences } from "electron";
import { windowChannels } from "../../shared/window.ts";

/** 缩放 / 还原二合一。macOS 上 maximize 就是 zoom（不是全屏），与系统双击标题栏同义 */
function toggleZoom(window: BrowserWindow): void {
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
}

/**
 * 双击标题栏该做什么。macOS 读系统设置「连按窗口标题栏以」（桌面与程序坞）：
 * Minimize / None / Maximize（新系统还有 Fill，当作缩放）。没设过等于缩放——这是系统默认。
 * 非 macOS 没有这个偏好，双击就是最大化 / 还原。
 */
function titleDoubleClickAction(): "zoom" | "minimize" | "none" {
  if (process.platform !== "darwin") return "zoom";
  const pref = systemPreferences.getUserDefault("AppleActionOnDoubleClick", "string");
  if (pref === "Minimize") return "minimize";
  if (pref === "None") return "none";
  return "zoom";
}

export function registerWindowIpc(): void {
  const of = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle(windowChannels.windowMinimize, (event) => {
    of(event)?.minimize();
  });

  // 最大化 / 还原二合一：按钮只有一个，按当前状态切换
  ipcMain.handle(windowChannels.windowToggleMaximize, (event) => {
    const window = of(event);
    if (window !== null) toggleZoom(window);
  });

  // 标题栏双击（见 shared/window.ts 的说明）：系统在拖拽区上自己识别双击时灵时不灵，渲染层发回来
  ipcMain.handle(windowChannels.windowTitleDoubleClick, (event) => {
    const window = of(event);
    if (window === null) return;
    const action = titleDoubleClickAction();
    if (action === "zoom") toggleZoom(window);
    else if (action === "minimize") window.minimize();
  });

  ipcMain.handle(windowChannels.windowClose, (event) => {
    of(event)?.close();
  });
}
