/**
 * computer use 的 IPC —— 四层契约的第 2 层。
 * 四个入口都是 renderer 发起、主进程执行；沙箱状态机每次迁移经 computerUseStatus 推给
 * renderer（主窗口广播，同 channel 域的 broadcastChannelEvent 形态）。
 * PR1 只落这层与契约层；preload / renderer 面（第 3、4 层）随 renderer 刀接上。
 */
import { ipcMain } from "electron";
import { mainWindows } from "../window/main-windows.ts";
import {
  computerUseChannels,
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import type { SandboxController } from "./sandbox.ts";

export function registerComputerUseIpc(controller: SandboxController): void {
  ipcMain.handle(computerUseChannels.computerUseProbe, (): Promise<ComputerUseProbeResult> => controller.probe());
  ipcMain.handle(
    computerUseChannels.computerUseStart,
    (): Promise<ComputerUseStartResult> => controller.start(),
  );
  ipcMain.handle(computerUseChannels.computerUseStop, (): Promise<ComputerUseStopResult> => controller.stop());
  ipcMain.handle(
    computerUseChannels.computerUseScreenshot,
    (_event, maxWidth: unknown): Promise<ComputerUseScreenshotResult> =>
      controller.screenshot(typeof maxWidth === "number" ? maxWidth : undefined),
  );
}

/** 主进程 → 所有主窗口：沙箱状态迁移。renderer 冷启动按 off 画（沙箱不跨应用存活）。 */
export function broadcastComputerUseStatus(status: SandboxStatus): void {
  for (const window of mainWindows.list()) {
    window.webContents.send(computerUseChannels.computerUseStatus, status);
  }
}
