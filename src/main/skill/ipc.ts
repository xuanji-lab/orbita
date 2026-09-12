/**
 * Skills 的 IPC —— 四层契约的第 2 层。
 * 揭示目录必须走主进程：renderer 在 sandbox 里没有文件系统访问权。
 */
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { SkillContent, SkillMeta, SkillPatch, SkillScope } from "../../shared/skill.ts";
import type { SkillStore } from "./store.ts";

export function registerSkillIpc(store: SkillStore): void {
  ipcMain.handle(ipcChannels.skillList, (): Promise<SkillMeta[]> => store.list());
  ipcMain.handle(ipcChannels.skillLink, (_event, slug: string, scope: SkillScope): Promise<void> =>
    store.link(slug, scope),
  );
  ipcMain.handle(ipcChannels.skillUnlink, (_event, slug: string, scope: SkillScope): Promise<void> =>
    store.unlink(slug, scope),
  );
  ipcMain.handle(ipcChannels.skillClean, (_event, slug: string): Promise<void> => store.clean(slug));
  /** 应用内新建（4-1）：表单在面板里，主进程只落盘 */
  ipcMain.handle(
    ipcChannels.skillCreate,
    (_event, slug: string, name: string, scope: SkillScope | null): Promise<void> =>
      store.create(slug, name, scope),
  );
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
