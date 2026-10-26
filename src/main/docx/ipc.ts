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
import { whitelistedTargetPath } from "../files/list.ts";
import { readDocxFile } from "./read.ts";
import { saveDocxFile } from "./write.ts";

/**
 * @param backupDir 上一版的备份根（`<userData>/docx-backups`）。备份放应用数据目录，
 * 不进工作区——工作区里多出来的文件会出现在文件面板与 git 状态里。
 */
export function registerDocxIpc(workspaces: WorkspaceStore, sessions: SessionStore, backupDir: string): void {
  ipcMain.handle(ipcChannels.docxOpen, async (_event, req: FileListRequest): Promise<DocxOpenResult> => {
    const roots = await resolveFileRoots(workspaces, sessions, req);
    // 打开也走 whitelistedTargetPath：文件在打开这一刻已经被外部删掉时，要回
    // invalid(missing) 让面板说一句人话，而不是把「目录不存在」的原始报错糊上去
    // （编辑器开着、用户在文件管理器里删了它、再点刷新——这是真会发生的顺序）
    const target = await whitelistedTargetPath(roots, req);
    if ("missing" in target) return { kind: "invalid", reason: "missing", size: 0, modifiedAt: 0 };
    if (!isDocxFile(target.path)) throw new Error(`Not a Word document: ${target.path}`);
    return readDocxFile(target.path);
  });

  ipcMain.handle(ipcChannels.docxSave, async (_event, req: DocxSaveRequest): Promise<DocxSaveResult> => {
    const roots = await resolveFileRoots(workspaces, sessions, req.target);
    // 写通道用 whitelistedTargetPath：文件被外部删掉时它仍给出合法路径，
    // 「文件没了」于是走到 saveDocxFile 的 conflict(missing)，而不是一句
    // 「目录不存在」的原始 IPC 报错（2026-10-24 评审复现）
    const target = await whitelistedTargetPath(roots, req.target);
    if ("missing" in target) return { kind: "conflict", reason: "missing", modifiedAt: null };
    if (!isDocxFile(target.path)) throw new Error(`Not a Word document: ${target.path}`);
    if (!(req.data instanceof Uint8Array)) throw new Error("docx:save expects the serialized document bytes");
    return saveDocxFile({
      path: target.path,
      expectedHash: req.expectedHash,
      data: req.data,
      backupDir,
    });
  });
}
