/**
 * 电源状态的 contextBridge 面 —— 四层契约的第 3 层（契约在 shared/power.ts）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isPowerState, type PowerState } from "../../shared/power.ts";

export const powerApi = {
  /** 此刻接没接电源 */
  state: (): Promise<PowerState> => ipcRenderer.invoke(ipcChannels.powerState),
  /** 接上 / 拔掉电源时回调；返回退订函数 */
  onChange: (listener: (state: PowerState) => void): (() => void) => {
    const handler = (_event: unknown, raw: unknown): void => {
      if (isPowerState(raw)) listener(raw);
    };
    ipcRenderer.on(ipcChannels.powerChanged, handler);
    return () => {
      ipcRenderer.removeListener(ipcChannels.powerChanged, handler);
    };
  },
} as const;
