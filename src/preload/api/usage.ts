/**
 * 每日用量的 contextBridge 面 —— 四层契约的第 3 层。
 * 拉取是 invoke，更新是主进程推送（usage:event，账本每次变化一份完整 7 天快照）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { UsageDayTotal, UsageWeekEvent } from "../../shared/usage.ts";

export const usageApi = {
  /** 最近 7 天（含今天，旧的在前，缺的天为 0）。回填在途时可能全 0，随后有推送纠真 */
  week: (): Promise<UsageDayTotal[]> => ipcRenderer.invoke(ipcChannels.usageWeek),
  onEvent: (listener: (event: UsageWeekEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: UsageWeekEvent) => listener(event);
    ipcRenderer.on(ipcChannels.usageEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.usageEvent, handler);
  },
};
