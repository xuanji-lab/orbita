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
  type EmergencyStopStatus,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import type { SandboxController } from "./sandbox.ts";
import type { EmergencyStopController } from "./emergency-stop.ts";

/**
 * 停沙箱前的收尾钩子（可选）。PR3 用它把沙箱里的 Edge 先停掉：`cdp-stop` 只杀我们自己
 * 记录的那个进程树，桥已经不响应就算了——沙箱销毁会带走整个 VM。
 * **不做成等待**：停沙箱是用户按的按钮，不能被一条浏览器命令拖住 45 秒。
 */
export interface ComputerUseIpcHooks {
  beforeStop?: () => void;
}

export function registerComputerUseIpc(
  controller: SandboxController,
  hooks: ComputerUseIpcHooks = {},
  /**
   * 急停热键的控制器（optional：旧测试 / 未接线的场景没有它）。设置页问注册状态，
   * 失败时如实显示「被占用」，不假装保护存在。
   */
  emergencyStop?: EmergencyStopController,
): void {
  ipcMain.handle(computerUseChannels.computerUseProbe, (): Promise<ComputerUseProbeResult> => controller.probe());
  ipcMain.handle(computerUseChannels.computerUseStatusGet, (): SandboxStatus => controller.status());
  ipcMain.handle(
    computerUseChannels.computerUseStart,
    (): Promise<ComputerUseStartResult> => controller.start(),
  );
  ipcMain.handle(computerUseChannels.computerUseStop, (): Promise<ComputerUseStopResult> => {
    hooks.beforeStop?.();
    return controller.stop();
  });
  ipcMain.handle(
    computerUseChannels.computerUseScreenshot,
    (_event, maxWidth: unknown): Promise<ComputerUseScreenshotResult> =>
      controller.screenshot(typeof maxWidth === "number" ? maxWidth : undefined),
  );
  ipcMain.handle(
    computerUseChannels.computerUseEmergencyStopState,
    (): EmergencyStopStatus =>
      emergencyStop?.status() ?? {
        accelerator: "",
        registered: false,
        error: "急停没有接线（主进程未注册热键）",
      },
  );
}

/** 主进程 → 所有主窗口：沙箱状态迁移。renderer 冷启动按 off 画（沙箱不跨应用存活）。 */
export function broadcastComputerUseStatus(status: SandboxStatus): void {
  for (const window of mainWindows.list()) {
    window.webContents.send(computerUseChannels.computerUseStatus, status);
  }
}
