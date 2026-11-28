/**
 * 引用补全的 contextBridge 面 —— 四层契约的第 3 层。
 *
 * 只有一个方法：读一次当前项目的文献库。授权在主进程（`main/cite/ipc.ts` 用文件面板
 * 的白名单核 root + path），renderer 给不出目录。
 */
import { ipcRenderer } from "electron";
import {
  citeChannels,
  type CiteFileContext,
  type CiteLibraryOutcome,
  type CiteSaveOutcome,
  type CiteSaveRequest,
  type CiteSearchOutcome,
  type CiteSearchRequest,
  type CiteVerifyOutcome,
  type CiteVerifyRequest,
} from "../../shared/cite.ts";

export const citeApi = {
  /** 当前文件所属项目的 .bib 文献库；不在 LaTeX 项目里时 found:false */
  library: (req: CiteFileContext): Promise<CiteLibraryOutcome> =>
    ipcRenderer.invoke(citeChannels.library, req),
  /** 在线查一条文献（标题 / DOI / arXiv 编号）；用户点「查找」才会走到这里 */
  search: (req: CiteSearchRequest): Promise<CiteSearchOutcome> =>
    ipcRenderer.invoke(citeChannels.search, req),
  /** 把选中的结果追加进项目的 .bib，回写到哪个文件与生成的 key */
  save: (req: CiteSaveRequest): Promise<CiteSaveOutcome> =>
    ipcRenderer.invoke(citeChannels.save, req),
  /** 核验项目里的条目（Crossref / arXiv）；条目由主进程重读 .bib，只传上下文与可选 key */
  verify: (req: CiteVerifyRequest): Promise<CiteVerifyOutcome> =>
    ipcRenderer.invoke(citeChannels.verify, req),
} as const;
