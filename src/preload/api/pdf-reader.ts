/**
 * PDF 阅读器的 contextBridge 面 —— 四层契约的第 3 层（契约在 shared/pdf-reader.ts）。
 * open 走文件面板同一道白名单；save / delete / close 只带 token，不带路径。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  PdfReaderDeleteRequest,
  PdfReaderOpenRequest,
  PdfReaderOpenResult,
  PdfReaderSaveRequest,
  PdfReaderWriteResult,
} from "../../shared/pdf-reader.ts";

export const pdfReaderApi = {
  /** 打开一份 PDF：回 token、阅读器取字节的地址、数据文件里的批注；阅读器产物缺失时回 unavailable */
  open: (req: PdfReaderOpenRequest): Promise<PdfReaderOpenResult> => ipcRenderer.invoke(ipcChannels.pdfReaderOpen, req),
  /** 按 id 合并保存批注 */
  save: (req: PdfReaderSaveRequest): Promise<PdfReaderWriteResult> => ipcRenderer.invoke(ipcChannels.pdfReaderSave, req),
  /** 按 id 删除批注 */
  remove: (req: PdfReaderDeleteRequest): Promise<PdfReaderWriteResult> => ipcRenderer.invoke(ipcChannels.pdfReaderDelete, req),
  /** 关掉（作废 token） */
  close: (token: string): Promise<void> => ipcRenderer.invoke(ipcChannels.pdfReaderClose, token),
} as const;
