/**
 * 手机服务的设置 IPC —— 四层契约的第 2 层。
 * 处理与校验在 ipc-handlers.ts（纯核可测）；这里只把七条通道逐一注册到 ipcMain。
 */
import { ipcMain } from "electron";
import { mobileChannels } from "../../shared/mobile.ts";
import { createMobileIpcHandlers, type MobileIpcDeps } from "./ipc-handlers.ts";

export type { MobileIpcDeps } from "./ipc-handlers.ts";

export function registerMobileIpc(deps: MobileIpcDeps): void {
  const handlers = createMobileIpcHandlers(deps);
  ipcMain.handle(mobileChannels.get, () => handlers.get());
  ipcMain.handle(mobileChannels.setEnabled, (_event, raw: unknown) => handlers.setEnabled(raw));
  ipcMain.handle(mobileChannels.setBind, (_event, raw: unknown) => handlers.setBind(raw));
  ipcMain.handle(mobileChannels.offerCreate, () => handlers.offerCreate());
  ipcMain.handle(mobileChannels.offerCancel, () => handlers.offerCancel());
  ipcMain.handle(mobileChannels.devices, () => handlers.devices());
  ipcMain.handle(mobileChannels.revoke, (_event, raw: unknown) => handlers.revoke(raw));
}
