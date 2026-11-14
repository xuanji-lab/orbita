/**
 * docx 轻量编辑的 contextBridge 面 —— 四层契约的第 3 层（契约在 `shared/docx.ts`）。
 * 白名单在主进程：renderer 传 root/dir，主进程按会话的三类根现算并校验 realpath。
 *
 * 编辑请求是**主进程 → renderer**（agent 的 `edit_docx`）：renderer 订阅它，把请求交给
 * 当前挂着的 docx 编辑器，再用 `replyEdit` 回执。方向反过来，所以这里不是 invoke。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  DocxEditReplyMessage,
  DocxEditRequestMessage,
  DocxOpenResult,
  DocxSaveRequest,
  DocxSaveResult,
} from "../../shared/docx.ts";
import type { FileListRequest } from "../../shared/files.ts";

export const docxApi = {
  /** 读整份 .docx + 内容 hash（超过上限回 too-large，加密 / 坏包回 invalid） */
  open: (req: FileListRequest): Promise<DocxOpenResult> => ipcRenderer.invoke(ipcChannels.docxOpen, req),
  /** 写回整份 .docx；expectedHash 与磁盘现状不一致时回 conflict，一个字节都不写 */
  save: (req: DocxSaveRequest): Promise<DocxSaveResult> => ipcRenderer.invoke(ipcChannels.docxSave, req),
  /** 订阅 agent 的 docx 编辑请求；返回值取消订阅（编辑器卸载时必须调，别留一份死宿主） */
  onEditRequest: (handler: (message: DocxEditRequestMessage) => void): (() => void) => {
    const listener = (_event: unknown, message: DocxEditRequestMessage): void => handler(message);
    ipcRenderer.on(ipcChannels.docxEditRequest, listener);
    return () => {
      ipcRenderer.removeListener(ipcChannels.docxEditRequest, listener);
    };
  },
  /** 回执一条编辑请求（主进程按 requestId 结账；超时后的回执会被丢弃） */
  replyEdit: (message: DocxEditReplyMessage): void => {
    void ipcRenderer.invoke(ipcChannels.docxEditReply, message);
  },
} as const;
