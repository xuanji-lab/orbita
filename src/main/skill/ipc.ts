/**
 * Skills 的 IPC —— 四层契约的第 2 层。
 * 揭示目录必须走主进程：renderer 在 sandbox 里没有文件系统访问权。
 */
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { SkillArchiveEntry, SkillContent, SkillMeta, SkillPatch, SkillRestoreResult, SkillScope } from "../../shared/skill.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import type { SkillStore } from "./store.ts";

export function registerSkillIpc(store: SkillStore, workspaces: WorkspaceStore): void {
  ipcMain.handle(ipcChannels.skillList, (): Promise<SkillMeta[]> => store.list());
  ipcMain.handle(ipcChannels.skillLink, (_event, slug: string, scope: SkillScope): Promise<void> =>
    store.link(slug, scope),
  );
  ipcMain.handle(ipcChannels.skillUnlink, (_event, slug: string, scope: SkillScope): Promise<void> =>
    store.unlink(slug, scope),
  );
  ipcMain.handle(ipcChannels.skillClean, (_event, slug: string): Promise<void> => store.clean(slug));
  /**
   * 导入用户已有目录（4-1）。目录选择框在主进程开（同 workspaceAdd 的纪律：
   * renderer 在 sandbox 里没有文件系统访问权）；取消返回 null，选完由 store
   * 校验（没 SKILL.md / 目录名不合法 / 重名都会如实抛给面板）。
   */
  ipcMain.handle(
    ipcChannels.skillImport,
    async (event, scope: SkillScope | null): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = await (window
        ? dialog.showOpenDialog(window, { properties: ["openDirectory"] })
        : dialog.showOpenDialog({ properties: ["openDirectory"] }));
      const picked = result.canceled ? undefined : result.filePaths[0];
      if (picked === undefined) return null;
      return store.importFrom(picked, scope);
    },
  );
  ipcMain.handle(ipcChannels.skillRead, (_event, slug: string): Promise<SkillContent | null> =>
    store.read(slug),
  );
  ipcMain.handle(ipcChannels.skillWrite, (_event, slug: string, patch: SkillPatch): Promise<void> =>
    store.write(slug, patch),
  );

  /**
   * 归档 / 恢复 / 移除：renderer 只给 slug 或归档 id，路径一律主进程自己拼并校验（见 SkillStore.entryOf）。
   * 移除走系统废纸篓（`shell.trashItem`），可以从废纸篓找回。
   */
  ipcMain.handle(ipcChannels.skillArchive, async (_event, slug: string): Promise<void> => {
    await store.archive(slug);
  });
  ipcMain.handle(ipcChannels.skillArchived, (): Promise<SkillArchiveEntry[]> => store.listArchived());
  ipcMain.handle(ipcChannels.skillRestore, async (_event, id: string): Promise<SkillRestoreResult> => {
    const known = (await workspaces.list()).map((workspace) => workspace.id);
    return store.restore(id, known);
  });
  ipcMain.handle(ipcChannels.skillTrash, (_event, slug: string): Promise<void> => store.trash(slug, (path) => shell.trashItem(path)));

  /**
   * 在系统文件管理器里揭示这条 skill 的目录。
   * **新建与删除都走这里**：删除不可逆，而新建一个文件夹本来就是文件管理器最擅长的事，
   * 我们没有理由为它做一套弱化的 UI。传 null 打开中心存储根目录。
   */
  ipcMain.handle(ipcChannels.skillReveal, async (_event, slug: string | null): Promise<void> => {
    if (slug === null) {
      await shell.openPath(store.storeRoot());
      return;
    }
    const dir = await store.locateDir(slug);
    if (dir === null) throw new Error(`skill 不存在：${slug}`);
    shell.showItemInFolder(dir);
  });
}
