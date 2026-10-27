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
  type EmergencyStopStatus,
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
   * 取当前状态（挂载时拉一次）。**为什么需要它**：沙盒是应用级的，不随设置页卸载；
   * 而这里只订阅状态迁移的推送——用户离开设置页再回来（组件重挂载）时，初始 state 是 off，
   * 之后没有新的迁移可听，于是徽标永远按未启动画：停不掉正在跑的沙盒，点启动还会报
   * 「沙箱已经在运行」（2026-10-27 真机 P1，稳定复现 3/3）。
   * 这**不违背**「沙箱不跨应用存活」：应用活着但页面切走时，状态真实存在于主进程。
   */
  status: (): Promise<SandboxStatus> => ipcRenderer.invoke(computerUseChannels.computerUseStatusGet),
  /**
   * 订阅沙箱状态机的每次迁移，返回退订函数。
   */
  /** 急停热键的注册状态（设置页每次挂载问一次；失败时如实说「被占用」） */
  emergencyStopState: (): Promise<EmergencyStopStatus> =>
    ipcRenderer.invoke(computerUseChannels.computerUseEmergencyStopState),
  onStatus: (listener: (status: SandboxStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: SandboxStatus): void => listener(status);
    ipcRenderer.on(computerUseChannels.computerUseStatus, handler);
    return () => ipcRenderer.removeListener(computerUseChannels.computerUseStatus, handler);
  },
} as const;
