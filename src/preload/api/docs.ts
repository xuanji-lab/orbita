/**
 * 文档面板的 contextBridge 面 —— 四层契约的第 3 层。
 * 白名单与摘要比较都在主进程（shared/doc.ts 顶注释）：这里只是把请求递过去。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  DocChangedEvent,
  DocCreated,
  DocCreateRequest,
  DocExportRequest,
  DocExportResult,
  DocSaveAsRequest,
  DocSaveAsResult,
  DocFile,
  DocListEntry,
  DocListRequest,
  DocTarget,
  DocWriteRequest,
  DocWriteResult,
} from "../../shared/doc.ts";
import type {
  SlidesAddAssetRequest,
  SlidesAddedAsset,
  SlidesAssetBytes,
  SlidesConvertRequest,
  SlidesConverted,
  SlidesExportRequest,
  SlidesExportResult,
  SlidesReadAssetRequest,
} from "../../shared/slides-export.ts";

export const docsApi = {
  /** 读一份 .md（白名单同文件面板），回内容 + 摘要 */
  read: (req: DocTarget): Promise<DocFile> => ipcRenderer.invoke(ipcChannels.docRead, req),
  /** 写回：摘要对不上就不写、回盘上的现状（conflict） */
  write: (req: DocWriteRequest): Promise<DocWriteResult> => ipcRenderer.invoke(ipcChannels.docWrite, req),
  /** 在当前会话的工作区根下新建一份文档 / 演示文稿 */
  create: (req: DocCreateRequest): Promise<DocCreated> => ipcRenderer.invoke(ipcChannels.docCreate, req),
  /** 工作区里的 .md 列表（最近改的在前） */
  list: (req: DocListRequest): Promise<DocListEntry[]> => ipcRenderer.invoke(ipcChannels.docList, req),
  /** 开始监听一份文档；盘上变化走 onChanged */
  watch: (req: DocTarget): Promise<void> => ipcRenderer.invoke(ipcChannels.docWatch, req),
  unwatch: (req: DocTarget): Promise<void> => ipcRenderer.invoke(ipcChannels.docUnwatch, req),
  /** 订阅被监听文档的变化；返回退订函数 */
  onChanged: (listener: (event: DocChangedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DocChangedEvent): void => listener(payload);
    ipcRenderer.on(ipcChannels.docChanged, handler);
    return () => ipcRenderer.removeListener(ipcChannels.docChanged, handler);
  },
  /** 另存为：把当前文字存成新文件（先弹保存对话框） */
  saveAs: (req: DocSaveAsRequest): Promise<DocSaveAsResult> => ipcRenderer.invoke(ipcChannels.docSaveAs, req),
  /** 导出：文档 → docx、演示文稿 → PDF（先弹保存对话框） */
  export: (req: DocExportRequest): Promise<DocExportResult> => ipcRenderer.invoke(ipcChannels.docExport, req),
  /** 演示文稿 v2：导出 pdf / html / png / pptx（先弹保存对话框） */
  exportSlides: (req: SlidesExportRequest): Promise<SlidesExportResult> => ipcRenderer.invoke(ipcChannels.slidesExport, req),
  /** 演示文稿 v2：旧 Marp .md → 新格式 .slides.json */
  convertMarpDeck: (req: SlidesConvertRequest): Promise<SlidesConverted> => ipcRenderer.invoke(ipcChannels.slidesConvertMarp, req),
  /** 演示文稿 v2：读一张 assets 里的图（画布显示用） */
  readSlideAsset: (req: SlidesReadAssetRequest): Promise<SlidesAssetBytes> => ipcRenderer.invoke(ipcChannels.slidesReadAsset, req),
  /** 演示文稿 v2：把拖入 / 粘贴 / 选择的图片字节放进 assets */
  addSlideAsset: (req: SlidesAddAssetRequest): Promise<SlidesAddedAsset> => ipcRenderer.invoke(ipcChannels.slidesAddAsset, req),
} as const;
