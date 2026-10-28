/**
 * LaTeX 编译条的 contextBridge 面 —— 四层契约的第 3 层。
 * 授权在主进程（`main/latex/ipc.ts` 用文件面板的白名单核 root + path），
 * renderer 传什么都不信：它给不出 dir，项目目录由主进程从 path 找。
 */
import { ipcRenderer } from "electron";
import {
  latexChannels,
  type LatexCleanOutcome,
  type LatexCompileIpcRequest,
  type LatexConfigureOutcome,
  type LatexConfigureRequest,
  type LatexFileContext,
  type LatexLocateOutcome,
  type LatexProbeRequest,
  type LatexProjectOutcome,
  type LatexProbeResult,
  type LatexRunOutcome,
} from "../../shared/latex.ts";

export const latexApi = {
  /** 本机 latexmk 与可用引擎（主进程缓存；找不到时 ok:false + 一句原因） */
  probe: (req?: LatexProbeRequest): Promise<LatexProbeResult> =>
    ipcRenderer.invoke(latexChannels.probe, req ?? {}),
  /** 「指定位置」：系统文件选择器，现验通过才写进设置 */
  locate: (): Promise<LatexLocateOutcome> => ipcRenderer.invoke(latexChannels.locate),
  /** 当前文件所属的项目；不属于任何 LaTeX 项目时 found:false */
  project: (req: LatexFileContext): Promise<LatexProjectOutcome> =>
    ipcRenderer.invoke(latexChannels.project, req),
  /** 编一次（主文件 / 引擎读项目配置与 magic comment） */
  compile: (req: LatexCompileIpcRequest): Promise<LatexRunOutcome> =>
    ipcRenderer.invoke(latexChannels.compile, req),
  /** 取消这个项目在跑的编译；false = 已经没有在跑的 */
  cancel: (req: LatexFileContext): Promise<boolean> => ipcRenderer.invoke(latexChannels.cancel, req),
  /** 清理辅助文件（latexmk -c，保留 PDF）；removed / kept 是清理前后的差集 */
  clean: (req: LatexFileContext): Promise<LatexCleanOutcome> => ipcRenderer.invoke(latexChannels.clean, req),
  /** 把引擎 / 主文件选择写进项目 `.orbita/latex.json` */
  configure: (req: LatexConfigureRequest): Promise<LatexConfigureOutcome> =>
    ipcRenderer.invoke(latexChannels.configure, req),
} as const;
