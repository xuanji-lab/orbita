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
  type PandocProbeRequest,
  type PandocProbeResult,
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
} as const;
