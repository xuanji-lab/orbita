/**
 * 迁移的 contextBridge 面 —— 四层契约的第 3 层。
 * 探测（只 stat）/ 扫描（dry-run）/ 执行（按选择落盘）各一个通道；载荷形状见 shared/import.ts。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  ImportCustomRoot,
  ImportCustomRootInput,
  ImportDetectResult,
  ImportGreetingCheckInput,
  ImportGreetingCheckResult,
  ImportRunInput,
  ImportRunReport,
  ImportScanInput,
  ImportScanReport,
} from "../../shared/import.ts";

export const importApi = {
  /** 本机有哪些来源、各自会读哪些路径；只 stat，不读内容 */
  detect: (): Promise<ImportDetectResult> => ipcRenderer.invoke(ipcChannels.importDetect),
  /** 扫描勾选的来源；读不了数据根会以错误 reject（UI 错误态） */
  scan: (input: ImportScanInput): Promise<ImportScanReport> => ipcRenderer.invoke(ipcChannels.importScan, input),
  /** 执行导入：主进程按同样的来源重扫，再按勾选与去向落盘，返回实际导入 / 跳过 / 失败明细 */
  run: (input: ImportRunInput): Promise<ImportRunReport> => ipcRenderer.invoke(ipcChannels.importRun, input),
  /**
   * 可选检查：用家务活模型（设置里的 choreModel）判断哪些新会话只是随手发的一句 hi / test，
   * 返回判中的 sourceFile。要调模型；模型不可用（稳定错误码）、调用失败以错误 reject
   */
  checkGreetings: (input: ImportGreetingCheckInput): Promise<ImportGreetingCheckResult> =>
    ipcRenderer.invoke(ipcChannels.importCheckGreetings, input),
  /**
   * 自定义来源路径：把用户手动指定的目录经该来源 validate 后加进扫描清单。失败以稳定
   * 错误码 IMPORT_CUSTOM_ROOT_INVALID:* reject；成功返回更新后的清单
   */
  addCustomRoot: (input: ImportCustomRootInput): Promise<ImportCustomRoot[]> =>
    ipcRenderer.invoke(ipcChannels.importCustomRootsAdd, input),
  /** 移除一条自定义路径；目录本身永不被碰。返回更新后的清单 */
  removeCustomRoot: (input: ImportCustomRootInput): Promise<ImportCustomRoot[]> =>
    ipcRenderer.invoke(ipcChannels.importCustomRootsRemove, input),
  /** 目录选择框（主进程开）：选中返回绝对路径，取消返回 null */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(ipcChannels.importPickDirectory),
};
