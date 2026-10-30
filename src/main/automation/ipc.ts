/**
 * 自动化的 IPC —— 四层契约的第 2 层。
 * 校验与状态转移都在 requests.ts（纯核，可测）；这里只把通道接到那几个函数，并负责「变了就推」。
 * 通道在开关关着时也注册——`automation:list` 回空、写操作回「已关闭」（requests.ts 的 enabled 门），
 * 省得开关切换时反复注册 / 注销 handler。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { AutomationEvent } from "../../shared/automation.ts";
import { mainWindows } from "../window/main-windows.ts";
import {
  applyAutomationAct,
  applyAutomationCreate,
  applyAutomationPromote,
  applyAutomationUpdate,
  listAutomations,
  type AutomationRequestDeps,
} from "./requests.ts";

export function registerAutomationIpc(deps: AutomationRequestDeps): void {
  ipcMain.handle(ipcChannels.automationList, () => listAutomations(deps));
  ipcMain.handle(ipcChannels.automationCreate, (_e, input: unknown) => applyAutomationCreate(deps, input));
  ipcMain.handle(ipcChannels.automationUpdate, (_e, id: unknown, patch: unknown) => applyAutomationUpdate(deps, id, patch));
  ipcMain.handle(ipcChannels.automationAct, (_e, id: unknown, action: unknown) => applyAutomationAct(deps, id, action));
  ipcMain.handle(ipcChannels.automationPromote, (_e, sessionId: unknown) => applyAutomationPromote(deps, sessionId));
}

/** 主进程 → 所有主窗口：自动化变了，renderer 重拉列表 */
export function broadcastAutomationEvent(): void {
  const event: AutomationEvent = { type: "changed" };
  for (const window of mainWindows.list()) {
    window.webContents.send(ipcChannels.automationEvent, event);
  }
}
