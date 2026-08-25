/**
 * 工作区的 IPC —— 四层契约的第 2 层。
 * 选目录必须走主进程的原生对话框：renderer 在 sandbox 里没有文件系统访问权。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { WorkspaceStore } from "./store.ts";

export function registerWorkspaceIpc(store: WorkspaceStore): void {
  ipcMain.handle(ipcChannels.workspaceCurrent, () => store.current());
  ipcMain.handle(ipcChannels.workspaceDefault, () => WorkspaceStore.defaultPath());

  ipcMain.handle(ipcChannels.workspaceChoose, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await (window
      ? dialog.showOpenDialog(window, {
          properties: ["openDirectory", "createDirectory"],
          defaultPath: await store.current(),
        })
      : dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }));
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return null;
    await store.set(picked);
    return picked;
  });
}
