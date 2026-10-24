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
} from "../../shared/cite.ts";

export const citeApi = {
  /** 当前文件所属项目的 .bib 文献库；不在 LaTeX 项目里时 found:false */
  library: (req: CiteFileContext): Promise<CiteLibraryOutcome> =>
    ipcRenderer.invoke(citeChannels.library, req),
} as const;
