/**
 * LaTeX 编译条的 contextBridge 面 —— 四层契约的第 3 层。
 * 授权在主进程（`main/latex/ipc.ts` 用文件面板的白名单核 root + path），
 * renderer 传什么都不信：它给不出 dir，项目目录由主进程从 path 找。
 */
import { ipcRenderer } from "electron";
import {
  latexChannels,
  type LatexCompileIpcRequest,
  type LatexConfigureOutcome,
  type LatexConfigureRequest,
  type LatexFileContext,
  type LatexForwardOutcome,
  type LatexForwardRequest,
  type LatexIndexOutcome,
  type LatexLintOutcome,
  type LatexProjectOutcome,
  type LatexProbeResult,
  type LatexPackageQuery,
  type LatexResolvedPackage,
  type LatexReverseOutcome,
  type LatexReverseRequest,
  type LatexRunOutcome,
} from "../../shared/latex.ts";

export const latexApi = {
  /** 本机 latexmk 与可用引擎（主进程缓存；找不到时 ok:false + 一句原因） */
  probe: (): Promise<LatexProbeResult> => ipcRenderer.invoke(latexChannels.probe),
  /** 当前文件所属的项目；不属于任何 LaTeX 项目时 found:false */
  project: (req: LatexFileContext): Promise<LatexProjectOutcome> =>
    ipcRenderer.invoke(latexChannels.project, req),
  /** 编一次（主文件 / 引擎读项目配置与 magic comment） */
  compile: (req: LatexCompileIpcRequest): Promise<LatexRunOutcome> =>
    ipcRenderer.invoke(latexChannels.compile, req),
  /** 取消这个项目在跑的编译；false = 已经没有在跑的 */
  cancel: (req: LatexFileContext): Promise<boolean> => ipcRenderer.invoke(latexChannels.cancel, req),
  /** 把引擎 / 主文件选择写进项目 `.orbita/latex.json` */
  configure: (req: LatexConfigureRequest): Promise<LatexConfigureOutcome> =>
    ipcRenderer.invoke(latexChannels.configure, req),
  /** 源码行 → PDF 位置（SyncTeX 正向；失败时 reason 说明是哪一种） */
  synctexForward: (req: LatexForwardRequest): Promise<LatexForwardOutcome> =>
    ipcRenderer.invoke(latexChannels.synctexForward, req),
  /** PDF 页面坐标 → 源码行（SyncTeX 反向） */
  synctexReverse: (req: LatexReverseRequest): Promise<LatexReverseOutcome> =>
    ipcRenderer.invoke(latexChannels.synctexReverse, req),
  /** 缺的文件名 → 发行版包名与安装命令（未知包时 packageName/command 为 null） */
  packages: (req: LatexPackageQuery): Promise<LatexResolvedPackage[]> =>
    ipcRenderer.invoke(latexChannels.packages, req),
  /** 项目符号索引（`\ref` / 自定义命令 / 路径补全读它）；不属于项目时 found:false */
  index: (req: LatexFileContext): Promise<LatexIndexOutcome> =>
    ipcRenderer.invoke(latexChannels.index, req),
  /** chktex 行内检查；本机没装时 available:false（界面据此不显示） */
  lint: (req: LatexFileContext): Promise<LatexLintOutcome> =>
    ipcRenderer.invoke(latexChannels.lint, req),
} as const;
