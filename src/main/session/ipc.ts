/**
 * 会话的 IPC —— 四层契约的第 2 层。
 * 落盘那一半在 `recorder.ts`：它是纯模块，抽出去是为了能被 `node --test` 直接测。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { SessionStore } from "./store.ts";

export function registerSessionIpc(store: SessionStore): void {
  ipcMain.handle(ipcChannels.sessionList, () => store.list());
  ipcMain.handle(ipcChannels.sessionLoad, (_event, id: string) => store.load(id));
  ipcMain.handle(ipcChannels.sessionDelete, (_event, id: string) => store.remove(id));
}
