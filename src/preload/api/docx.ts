/**
 * docx 轻量编辑的 contextBridge 面 —— 四层契约的第 3 层（契约在 `shared/docx.ts`）。
 * 白名单在主进程：renderer 传 root/dir，主进程按会话的三类根现算并校验 realpath。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { DocxOpenResult, DocxSaveRequest, DocxSaveResult } from "../../shared/docx.ts";
import type { FileListRequest } from "../../shared/files.ts";

export const docxApi = {
  /** 读整份 .docx + 内容 hash（超过上限回 too-large，加密 / 坏包回 invalid） */
  open: (req: FileListRequest): Promise<DocxOpenResult> => ipcRenderer.invoke(ipcChannels.docxOpen, req),
  /** 写回整份 .docx；expectedHash 与磁盘现状不一致时回 conflict，一个字节都不写 */
  save: (req: DocxSaveRequest): Promise<DocxSaveResult> => ipcRenderer.invoke(ipcChannels.docxSave, req),
} as const;
