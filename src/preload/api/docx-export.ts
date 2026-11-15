/**
 * Word 导出的 contextBridge 面 —— 四层契约的第 3 层。
 *
 * 只有机器级配置的三条通道（pandoc 探测 / 模板体检 / 选择模板）；导出本身由 agent
 * 工具 `export_docx` 走 requestId 问答，不经 renderer（那里拿不到会话授权目录）。
 */
import { ipcRenderer } from "electron";
import {
  docxExportChannels,
  type DocxTemplateInspectOutcome,
  type DocxTemplateInspectRequest,
  type DocxTemplatePickOutcome,
  type PandocLocateOutcome,
  type PandocProbeRequest,
  type PandocProbeResult,
  type PandocVerifyOutcome,
  type PandocVerifyRequest,
} from "../../shared/docx-export.ts";

export const docxExportApi = {
  /** 本机 pandoc 与版本是否够（缓存；refresh=true 现探） */
  probe: (req?: PandocProbeRequest): Promise<PandocProbeResult> =>
    ipcRenderer.invoke(docxExportChannels.probe, req ?? {}),
  /** 体检当前模板（path 缺席 = 设置里当前那一份；默认 / 项目模板只回约定说明） */
  inspect: (req?: DocxTemplateInspectRequest): Promise<DocxTemplateInspectOutcome> =>
    ipcRenderer.invoke(docxExportChannels.inspect, req ?? {}),
  /** 选择学校模板：系统文件选择器 → 体检通过才写设置 */
  pickTemplate: (): Promise<DocxTemplatePickOutcome> => ipcRenderer.invoke(docxExportChannels.pickTemplate),
  /** 现验一条 pandoc 路径（不回退 PATH）；设置页手填路径用 */
  verifyPandoc: (req: PandocVerifyRequest): Promise<PandocVerifyOutcome> =>
    ipcRenderer.invoke(docxExportChannels.verifyPandoc, req),
  /** 选择 pandoc 可执行文件：系统文件选择器 → 现验；写设置由渲染层做 */
  pickPandoc: (): Promise<PandocLocateOutcome> => ipcRenderer.invoke(docxExportChannels.pickPandoc),
} as const;
