/**
 * 文件面板的 IPC —— 四层契约的第 2 层。
 * Finder 定位与目录读取都走主进程：renderer 在 sandbox 里没有文件系统访问权。
 */
import { ipcMain, shell } from "electron";
import { stat } from "node:fs/promises";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isWebPageFile, type FileListRequest, type FilePreview, type FileRootsRequest } from "../../shared/files.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { resolveFileRoots } from "./roots.ts";
import { listDirectory, whitelistedPath } from "./list.ts";
import { readPreview } from "./read.ts";

/**
 * @param openInBrowser 在内置浏览器「你的」tab 打开一个本地网页（BrowserSandbox.openLocalFile）。
 * 传函数不传沙盒：文件面板只需要这一个动作
 */
export function registerFilesIpc(
  workspaces: WorkspaceStore,
  sessions: SessionStore,
  openInBrowser: (path: string) => Promise<void>,
): void {
  ipcMain.handle(ipcChannels.fsRoots, (_event, req: FileRootsRequest) =>
    resolveFileRoots(workspaces, sessions, req),
  );

  // 根每次现算（同 fs:reveal）：工作台刚建、目录刚挂，下一次展开就要看得到，
  // 缓存只会把面板变成一份过期的地图
  ipcMain.handle(ipcChannels.fsList, async (_event, req: FileListRequest) => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    return listDirectory(roots, req);
  });

  /**
   * 在 Finder 里显示 `dir`（root/dir 白名单与 fs:list 同一道）。路径本身是目录就
   * `openPath`——「揭示」一个目录的意图是进去看，showItemInFolder 会停在父目录
   * 选中它，多一步；文件 / 链接则 showItemInFolder 定位选中。坏链接 stat 失败也
   * 走 showItemInFolder：链接本身还在，能定位就能看出来它坏了。
   */
  ipcMain.handle(ipcChannels.fsReveal, async (_event, req: FileListRequest): Promise<void> => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    const path = await whitelistedPath(roots, req);
    let isDirectory = false;
    try {
      isDirectory = (await stat(path)).isDirectory();
    } catch {
      // 坏链接：落在 showItemInFolder 一支
    }
    if (isDirectory) await shell.openPath(path);
    else shell.showItemInFolder(path);
  });

  /** 读一个文件给面板预览（root/dir 白名单与 fs:list 同一道） */
  ipcMain.handle(ipcChannels.fsRead, async (_event, req: FileListRequest): Promise<FilePreview> => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    const path = await whitelistedPath(roots, req);
    return readPreview(path);
  });

  /**
   * 用系统默认应用打开 dir（同白名单）。`shell.openPath` 失败时回一个非空字符串
   * 而不是抛错——这里统一成异常，让 renderer 一条 catch 处理到底。
   */
  ipcMain.handle(ipcChannels.fsOpen, async (_event, req: FileListRequest): Promise<void> => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    const path = await whitelistedPath(roots, req);
    const failure = await shell.openPath(path);
    if (failure !== "") {
      throw new Error(`Couldn't open ${path}: ${failure}`);
    }
  });

  /**
   * 网页文件的默认打开方式：内置浏览器（2026-09-29 裁决「全都默认用内置」）。同一道白名单，
   * 外加只认网页文件——这条通道不能变成「让浏览器加载任意本地文件」。判定用 realpath 之后的
   * 路径：指向别的类型的 foo.html 软链接同样被拒。
   */
  ipcMain.handle(ipcChannels.fsOpenInBrowser, async (_event, req: FileListRequest): Promise<void> => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    const path = await whitelistedPath(roots, req);
    if (!isWebPageFile(path)) throw new Error(`Only web pages open in the built-in browser; ${path} is not one.`);
    await openInBrowser(path);
  });
}
