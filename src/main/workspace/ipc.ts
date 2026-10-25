/**
 * 工作区的 IPC —— 四层契约的第 2 层。
 * 选目录必须走主进程的原生对话框：renderer 在 sandbox 里没有文件系统访问权。
 *
 * 每个写操作都经 `afterWorkspaceMutation`：写盘成功才广播 `workspacesChanged`，
 * renderer 收到重读 `workspace:list`（列表是全局事实，任何入口写的都该让所有窗口看见）。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { afterWorkspaceMutation } from "./change.ts";
import { WorkspaceStore } from "./store.ts";

export function registerWorkspaceIpc(
  store: WorkspaceStore,
  /** 工作区被移除时的连带清理（2-1b：删它的 skill 集合目录，只删链接不伤存储） */
  onRemove: (id: string) => Promise<void> | void,
  /** 列表变了（主进程写完广播）：renderer 收到重读 workspace:list */
  onChanged: () => void,
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
    return afterWorkspaceMutation(() => store.add(picked), onChanged);
  });

  ipcMain.handle(ipcChannels.workspaceRename, async (_event, id: string, name: string) => {
    await afterWorkspaceMutation(() => store.rename(id, name), onChanged);
  });
  // 命名新建：目录选择器帮不上忙——用户要的是「在 ~/Orbita 里开一个新家」而不是挑一个已有的
  ipcMain.handle(ipcChannels.workspaceCreate, (_event, name: string) =>
    afterWorkspaceMutation(() => store.create(name), onChanged),
  );
  // 挂附加目录：选择器在主进程开（同 workspaceAdd 的纪律），校验（存在 / 是目录 / 去重）在 store。
  // id null = Home（Home 也是工作区，同样能挂）；取消返回 null，成功返回更新后的 attachedDirs
  ipcMain.handle(
    ipcChannels.workspaceAttachDir,
    async (event, id: string | null): Promise<string[] | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = await (window
        ? dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })
        : dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }));
      const picked = result.canceled ? undefined : result.filePaths[0];
      if (picked === undefined) return null;
      return afterWorkspaceMutation(() => store.attachDir(id, picked), onChanged);
    },
  );
  // 摘附加目录：幂等（不在列表里不报错），返回更新后的 attachedDirs——面板拿它刷新根清单
  ipcMain.handle(
    ipcChannels.workspaceDetachDir,
    (_event, id: string | null, dir: string): Promise<string[]> =>
      afterWorkspaceMutation(() => store.detachDir(id, dir), onChanged),
  );
  ipcMain.handle(ipcChannels.workspaceRemove, async (_event, id: string) => {
    await afterWorkspaceMutation(async () => {
      await store.remove(id);
      // 连带清理失败不拦工作区移除（那是一件更主要的事），但必须留日志——
      // 悬空的集合目录会让 skill 多出一个看不见的归属面
      await Promise.resolve(onRemove(id)).catch((cause: unknown) => {
        console.error(`[main] 工作区 ${id} 的 skill 集合目录没删掉`, cause);
      });
    }, onChanged);
  });
}
