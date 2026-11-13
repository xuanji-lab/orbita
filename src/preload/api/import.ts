/**
 * 配置导入（技能、MCP）与自定义数据目录的 contextBridge 面 —— 四层契约的第 3 层。
 * 载荷形状见 shared/import.ts。聊天记录不导入（外部会话只读：external-sources.ts）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  ImportCustomRoot,
  ImportCustomRootInput,
  ImportDetectResult,
  ImportRunInput,
  ImportRunReport,
  ImportScanInput,
  ImportScanReport,
} from "../../shared/import.ts";

export const importApi = {
  /** 第 1 步：各来源勾上之后会读的路径、有没有东西可读；只 stat，不读内容 */
  detect: (): Promise<ImportDetectResult> => ipcRenderer.invoke(ipcChannels.importDetect),
  /** 扫描勾选来源里的技能与 MCP；读不了会以错误 reject（UI 错误态） */
  scan: (input: ImportScanInput): Promise<ImportScanReport> => ipcRenderer.invoke(ipcChannels.importScan, input),
  /** 导入勾选的技能与 MCP：主进程按同样的来源重扫，再按勾选落盘 */
  run: (input: ImportRunInput): Promise<ImportRunReport> => ipcRenderer.invoke(ipcChannels.importRun, input),
  /** 加一个自定义数据目录：过该来源的检查才落盘，失败以稳定错误码 reject */
  addCustomRoot: (input: ImportCustomRootInput): Promise<ImportCustomRoot[]> =>
    ipcRenderer.invoke(ipcChannels.importCustomRootsAdd, input),
  /** 移除一个自定义数据目录（目录本身不动） */
  removeCustomRoot: (input: ImportCustomRootInput): Promise<ImportCustomRoot[]> =>
    ipcRenderer.invoke(ipcChannels.importCustomRootsRemove, input),
  /** 目录选择框：选中返回绝对路径，取消返回 null */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(ipcChannels.importPickDirectory),
};
