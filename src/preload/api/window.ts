/**
 * 窗口的 contextBridge 面 —— 四层契约的第 3 层。
 * 转帧式窗口后自绘标题栏三键的回发通道；都足 fired-and-forget，没有返回值。
 */
import { ipcRenderer } from "electron";
import { windowChannels } from "../../shared/window.ts";

export const windowApi = {
  minimize: (): Promise<void> => ipcRenderer.invoke(windowChannels.windowMinimize),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke(windowChannels.windowToggleMaximize),
  close: (): Promise<void> => ipcRenderer.invoke(windowChannels.windowClose),
};
