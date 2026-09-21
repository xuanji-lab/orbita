/**
 * 导入的 contextBridge 面 —— 四层契约的第 3 层。
 * 扫描（dry-run 汇总）与执行（重新扫描后落盘）各一个通道；载荷形状见 shared/import.ts。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ImportRunReport, ImportScanReport } from "../../shared/import.ts";

export const importApi = {
  /** 扫描 Proma 的 pi 会话真源；读不了数据根会以错误 reject（UI 错误态） */
  scan: (): Promise<ImportScanReport> => ipcRenderer.invoke(ipcChannels.importScan),
  /** 执行导入：主进程重新扫描后落盘，返回实际导入 / 跳过 / 失败明细 */
  run: (): Promise<ImportRunReport> => ipcRenderer.invoke(ipcChannels.importRun),
};
