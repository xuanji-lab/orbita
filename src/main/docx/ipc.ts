/**
 * docx 的 IPC —— 四层契约的第 2 层（契约在 `shared/docx.ts`）。
 *
 * 白名单与 `fs:read` 同一道：`resolveFileRoots` 现算 + `whitelistedPath` 做 realpath
 * 之后的前缀校验。写入通道因此比读通道更危险——它同样只允许落在会话的三类根之内，
 * 且只认 `.docx`（realpath 之后判，改名的软链接被拒）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isDocxFile, type DocxOpenResult, type DocxSaveRequest, type DocxSaveResult } from "../../shared/docx.ts";
import type { FileListRequest } from "../../shared/files.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { resolveFileRoots } from "../files/roots.ts";
import { whitelistedPath } from "../files/list.ts";
import { readDocxFile } from "./read.ts";
import { saveDocxFile } from "./write.ts";

/**
 * @param backupDir 上一版的备份根（`<userData>/docx-backups`）。备份放应用数据目录，
 * 不进工作区——工作区里多出来的文件会出现在文件面板与 git 状态里。
 */
export function registerDocxIpc(workspaces: WorkspaceStore, sessions: SessionStore, backupDir: string): void {
  ipcMain.handle(ipcChannels.docxOpen, async (_event, req: FileListRequest): Promise<DocxOpenResult> => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    const path = await whitelistedPath(roots, req);
    if (!isDocxFile(path)) throw new Error(`Not a Word document: ${path}`);
    return readDocxFile(path);
  });

  ipcMain.handle(ipcChannels.docxSave, async (_event, req: DocxSaveRequest): Promise<DocxSaveResult> => {
    const roots = await resolveFileRoots(workspaces, sessions, req.target);
    const path = await whitelistedPath(roots, req.target);
    if (!isDocxFile(path)) throw new Error(`Not a Word document: ${path}`);
    if (!(req.data instanceof Uint8Array)) throw new Error("docx:save expects the serialized document bytes");
    return saveDocxFile({
      path,
      expectedHash: req.expectedHash,
      data: req.data,
      backupDir,
    });
  });
}
