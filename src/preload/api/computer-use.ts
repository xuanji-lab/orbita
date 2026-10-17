/**
 * computer use 的 contextBridge 面 —— 四层契约的第 3 层。
 *
 * 唯一调用方是主窗口「设置 › 电脑使用」：能力探测、沙箱启停、手动「看一眼」截图。
 * agent 进程驱动沙箱是 PR2/3 的事，不经这条桥（同 browser 域：agent 走自己的直连）。
 */
import { ipcRenderer } from "electron";
import {
  computerUseChannels,
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type SandboxStatus,
} from "../../shared/computer-use.ts";

export const computerUseApi = {
  /** 能力探测（全只读）：Windows 版本、沙箱功能状态、可执行文件在不在；未就绪时给手动开启指引 */
  probe: (): Promise<ComputerUseProbeResult> => ipcRenderer.invoke(computerUseChannels.computerUseProbe),
  /** 生成 .wsb 并启动沙箱。回执只说这次调用本身，最新状态一律听 onStatus 的推送 */
  start: (): Promise<ComputerUseStartResult> => ipcRenderer.invoke(computerUseChannels.computerUseStart),
  /** 停止沙箱（幂等）；starting 时它是「取消启动」，error 时它兼任复位 */
  stop: (): Promise<ComputerUseStopResult> => ipcRenderer.invoke(computerUseChannels.computerUseStop),
  /** 对沙箱桌面截一张；maxWidth 缺省时主进程按 1280 处理（夹取 320–4096） */
  screenshot: (maxWidth?: number): Promise<ComputerUseScreenshotResult> =>
    ipcRenderer.invoke(computerUseChannels.computerUseScreenshot, maxWidth),
  /**
   * 订阅沙箱状态机的每次迁移，返回退订函数。没有拉取通道——沙箱不跨应用存活
   * （shared/computer-use.ts 的契约说明），renderer 冷启动直接按 off 画。
   */
  onStatus: (listener: (status: SandboxStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: SandboxStatus): void => listener(status);
    ipcRenderer.on(computerUseChannels.computerUseStatus, handler);
    return () => ipcRenderer.removeListener(computerUseChannels.computerUseStatus, handler);
  },
} as const;
