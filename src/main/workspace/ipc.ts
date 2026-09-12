/**
 * 工作区的 IPC —— 四层契约的第 2 层。
 * 选目录必须走主进程的原生对话框：renderer 在 sandbox 里没有文件系统访问权。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { WorkspaceStore } from "./store.ts";

export function registerWorkspaceIpc(
  store: WorkspaceStore,
  /** 工作区被移除时的连带清理（2-1b：删它的 skill 集合目录，只删链接不伤存储） */
  onRemove: (id: string) => Promise<void> | void,
): void {
  ipcMain.handle(ipcChannels.workspaceList, () => store.list());
  ipcMain.handle(ipcChannels.workspaceDefault, () => WorkspaceStore.defaultPath());

  ipcMain.handle(ipcChannels.workspaceAdd, async (event): Promise<Workspace | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ["openDirectory", "createDirectory"] as const,
      defaultPath: WorkspaceStore.defaultPath(),
    };
    const result = await (window
      ? dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : dialog.showOpenDialog({ ...options, properties: [...options.properties] }));
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return null;
    return store.add(picked);
  });

  ipcMain.handle(ipcChannels.workspaceRename, (_event, id: string, name: string) =>
    store.rename(id, name),
  );
  ipcMain.handle(ipcChannels.workspaceRemove, async (_event, id: string) => {
    await store.remove(id);
    // 连带清理失败不拦工作区移除（那是一件更主要的事），但必须留日志——
    // 悬空的集合目录会让 skill 多出一个看不见的归属面
    await Promise.resolve(onRemove(id)).catch((cause: unknown) => {
      console.error(`[main] 工作区 ${id} 的 skill 集合目录没删掉`, cause);
    });
  });
}
