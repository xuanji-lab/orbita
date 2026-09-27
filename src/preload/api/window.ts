/**
 * 窗口的 contextBridge 面 —— 四层契约的第 3 层。
 * 转帧式窗口后自绘标题栏三键的回发通道；都是 fired-and-forget，没有返回值。
 */
import { ipcRenderer, webUtils } from "electron";
import { windowChannels } from "../../shared/window.ts";

export const windowApi = {
  minimize: (): Promise<void> => ipcRenderer.invoke(windowChannels.windowMinimize),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke(windowChannels.windowToggleMaximize),
  close: (): Promise<void> => ipcRenderer.invoke(windowChannels.windowClose),
  /**
   * 拖入 / 粘贴的文件在磁盘上的绝对路径。**不是 IPC 通道**：webUtils 只在 preload
   * 可用（sandbox 的 renderer 读不到 File 的 path 属性，Electron 32 起被移除），
   * File 对象经 contextBridge 传进来、这里解出路径再回去。空串 = 拿不到路径
   * （剪贴板里没有磁盘来源的条目），调用方当作拒绝处理。
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};
