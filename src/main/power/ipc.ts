/**
 * 电源状态的 IPC —— 四层契约的第 2 层（契约在 shared/power.ts）。
 * power:state 现问 powerMonitor.isOnBatteryPower()；on-battery / on-ac 时把新状态广播给主窗口（power:changed）。
 *
 * 开发时没有电池可拔（台式机、合着盖接着电）：未打包时可用环境变量 ORBITA_DEV_ON_BATTERY=1 起实例，当作一直在用电池——
 * 只在 !app.isPackaged 时认，打包版不受影响。真离电要在笔记本上拔线验。
 */
import { app, ipcMain, powerMonitor } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { PowerState } from "../../shared/power.ts";
import { mainWindows } from "../window/main-windows.ts";

function devOnBattery(): boolean {
  return !app.isPackaged && process.env["ORBITA_DEV_ON_BATTERY"] === "1";
}

export function readPowerState(): PowerState {
  return { onBattery: devOnBattery() || powerMonitor.isOnBatteryPower() };
}

export function registerPowerIpc(): void {
  ipcMain.handle(ipcChannels.powerState, (): PowerState => readPowerState());
  const broadcast = (state: PowerState): void => {
    for (const window of mainWindows.list()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(ipcChannels.powerChanged, state);
    }
  };
  powerMonitor.on("on-battery", () => broadcast({ onBattery: true }));
  powerMonitor.on("on-ac", () => broadcast({ onBattery: devOnBattery() }));
}
