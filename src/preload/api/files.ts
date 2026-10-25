/**
 * 文件面板的 contextBridge 面 —— 四层契约的第 3 层。
 * 白名单在主进程（shared/files.ts 顶注释）：renderer 传什么都不信，列出来的
 * 一定落在根之内。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  FileLineIndex,
  FileLines,
  FileLinesRequest,
  FileListRequest,
  FileListResponse,
  FilePreview,
  FileRoot,
  FileRootsRequest,
  FsEntryFact,
  PdfFile,
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
  /** 读 PDF 整份字节给预览面板渲染（同白名单，且须是 .pdf；实验功能「PDF 引用」） */
  readPdf: (req: FileListRequest): Promise<PdfFile> => ipcRenderer.invoke(ipcChannels.fsReadPdf, req),
  /** 建行索引（同 root/dir 白名单）：>16 MB 的文本走分段预览时先问这个文件有多少行 */
  lineIndex: (req: FileListRequest): Promise<FileLineIndex> =>
    ipcRenderer.invoke(ipcChannels.fsLineIndex, req),
  /** 按行读一段：只认 lineIndex 回的令牌，不传路径（白名单已在建索引时过完） */
  readLines: (req: FileLinesRequest): Promise<FileLines> =>
    ipcRenderer.invoke(ipcChannels.fsReadLines, req),
  /** 用系统默认应用打开 dir（同白名单） */
  open: (req: FileListRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.fsOpen, req),
  /** 在内置浏览器「你的」tab 打开网页文件（同白名单，且须是网页文件） */
  openInBrowser: (req: FileListRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.fsOpenInBrowser, req),
  /** 把一批绝对路径 stat 成盘上事实（输入框附件分拣与面板已发送附件列表用；不在面板白名单内）。stat 不到两个字段都是 null */
  statKind: (paths: readonly string[]): Promise<FsEntryFact[]> => ipcRenderer.invoke(ipcChannels.fsStatKind, paths),
  /** 开系统目录选择器挑文件夹（多选，给回形针的「添加文件夹」）；取消返回 null */
  pickFolders: (): Promise<string[] | null> => ipcRenderer.invoke(ipcChannels.fsPickFolders),
} as const;
