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
  ipcMain.handle(ipcChannels.workspaceDefault, () => store.defaultPath());

  ipcMain.handle(ipcChannels.workspaceAdd, async (event): Promise<Workspace | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ["openDirectory", "createDirectory"] as const,
      defaultPath: store.defaultPath(),
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
  // 命名新建：目录选择器帮不上忙——用户要的是「在 ~/Orbita 里开一个新家」而不是挑一个已有的
  ipcMain.handle(ipcChannels.workspaceCreate, (_event, name: string) => store.create(name));
  // 挂附加目录：选择器在主进程开（同 workspaceAdd 的纪律），校验（存在 / 是目录 / 去重）在 store
  ipcMain.handle(ipcChannels.workspaceAttachDir, async (event, id: string): Promise<Workspace | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await (window
      ? dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })
      : dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }));
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return null;
    return store.attachDir(id, picked);
  });
  // 摘附加目录：幂等（不在列表里不报错），返回更新后的工作区——面板要拿它刷新根清单
  ipcMain.handle(ipcChannels.workspaceDetachDir, (_event, id: string, dir: string): Promise<Workspace> =>
    store.detachDir(id, dir),
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
