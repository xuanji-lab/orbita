/**
 * 文件面板的 contextBridge 面 —— 四层契约的第 3 层。
 * 白名单在主进程（shared/files.ts 顶注释）：renderer 传什么都不信，列出来的
 * 一定落在根之内。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  FileListRequest,
  FileListResponse,
  FilePreview,
  FileRoot,
  FileRootsRequest,
} from "../../shared/files.ts";

export const filesApi = {
  /** 这条会话的根清单（工作台 / 工作区 / 附加目录），顺序固定、每次现算 */
  roots: (req: FileRootsRequest): Promise<FileRoot[]> => ipcRenderer.invoke(ipcChannels.fsRoots, req),
  /** 列一层目录；目录在前、同类按名字。root/dir 越出白名单由主进程拒绝 */
  list: (req: FileListRequest): Promise<FileListResponse> => ipcRenderer.invoke(ipcChannels.fsList, req),
  /** 在系统文件管理器里显示 dir（同 root/dir 白名单） */
  reveal: (req: FileListRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.fsReveal, req),
  /** 读一个文件给面板预览（同 root/dir 白名单，`dir` 就是文件路径） */
  read: (req: FileListRequest): Promise<FilePreview> => ipcRenderer.invoke(ipcChannels.fsRead, req),
  /** 用系统默认应用打开 dir（同白名单） */
  open: (req: FileListRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.fsOpen, req),
} as const;
