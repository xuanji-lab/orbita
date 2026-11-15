/**
 * Word 导出的 IPC —— 四层契约的第 2 层（契约在 `shared/docx-export.ts`，
 * preload 面在 `preload/api/docx-export.ts`）。
 *
 * 三条通道都只服务**机器级配置**（pandoc 位置、学校模板）：
 *
 * - `probe`：设置页显示 pandoc 版本；低于 3.10.2 时给升级提示。
 * - `inspect`：体检当前模板（默认模板需要 pandoc 现生成，项目模板要按源文件解析，
 *   这两者都没有现成路径可体检——所以 project 模式只回一条约定说明）。
 * - `pickTemplate`：系统文件选择器 → 体检 → **通过才写设置**。选到坏文件时设置不变，
 *   否则下次导出会在一个假模板上失败，比没选更难受（与 latex 的「指定位置」同一条纪律）。
 *
 * 导出本身不走这些通道：它要按会话授权目录校验路径，走 agent 的 requestId 问答
 * （`docx-export:run` 若开成 renderer 通道，就绕过了会话白名单）。
 */
import { readFile } from "node:fs/promises";
import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  docxExportChannels,
  type DocxTemplateInspectOutcome,
  type DocxTemplateInspectRequest,
  type DocxTemplatePickOutcome,
  type DocxTemplateReport,
  type PandocLocateOutcome,
  type PandocProbeRequest,
  type PandocProbeResult,
  type PandocVerifyOutcome,
  type PandocVerifyRequest,
} from "../../shared/docx-export.ts";
import type { SettingsStore } from "../settings/store.ts";
import { ensureDefaultTemplate } from "./default-template.ts";
import type { PandocProbe } from "./probe.ts";
import { inspectDocxTemplate } from "./template.ts";

export interface DocxExportIpcOptions {
  probe: PandocProbe;
  settings: SettingsStore;
  cacheDir: string;
  printReference: (pandocPath: string) => Promise<Uint8Array | null>;
}

export function registerDocxExportIpc(options: DocxExportIpcOptions): void {
  ipcMain.handle(docxExportChannels.probe, async (_event, req?: PandocProbeRequest): Promise<PandocProbeResult> => {
    const explicit = (await options.settings.read()).pandocPath;
    if (req?.refresh === true) options.probe.refresh();
    return options.probe.probe(explicit);
  });

  ipcMain.handle(
    docxExportChannels.inspect,
    async (_event, req?: DocxTemplateInspectRequest): Promise<DocxTemplateInspectOutcome> => {
      const settings = await options.settings.read();
      const explicitPath = req?.path?.trim();
      if (explicitPath !== undefined && explicitPath !== "") {
        return inspectFile(explicitPath, "custom");
      }
      if (settings.docxTemplateMode === "custom") {
        const custom = settings.docxTemplatePath?.trim();
        if (custom === undefined || custom === "") {
          return {
            requested: "custom",
            path: null,
            ok: false,
            verdict: "unusable",
            summary: "No school template is selected yet.",
            findings: [],
          };
        }
        return inspectFile(custom, "custom");
      }
      if (settings.docxTemplateMode === "project") {
        return {
          requested: "project",
          path: null,
          ok: true,
          verdict: "ok",
          summary: "Uses template.docx next to each source file; falls back to the built-in default when there is none.",
          findings: [],
        };
      }
      return inspectDefault(options, settings.pandocPath);
    },
  );

  /**
   * 现验一条 pandoc 路径（手填 / 选择共同用）。**不回退**：这条路径跑不起来就明确失败，
   * 界面据此给行内错误，而不是拿 PATH 上那份顶包、让用户以为自己的路径生效了。
   * 版本低于 3.10.2 仍算「跑得起来」——设置会写进去，状态显示「版本过低」；
   * 那是一个需要用户升级的真实状态，不是坏路径。
   */
  ipcMain.handle(
    docxExportChannels.verifyPandoc,
    async (_event, req: PandocVerifyRequest): Promise<PandocVerifyOutcome> => {
      const path = typeof req?.path === "string" ? req.path.trim() : "";
      if (path === "") return { ok: false, message: "Enter the absolute path to the pandoc executable." };
      const probe = await options.probe.probeExact(path);
      if (probe === null) {
        return {
          ok: false,
          message: `This path does not run as pandoc: ${path}. Pick the pandoc executable (pandoc.exe on Windows).`,
        };
      }
      return { ok: true, probe };
    },
  );

  /** 「选择 pandoc…」：系统文件选择器 → 现验 → 回结果；写设置由渲染层做（一个写入者） */
  ipcMain.handle(docxExportChannels.pickPandoc, async (): Promise<PandocLocateOutcome> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Select the pandoc executable",
      properties: ["openFile"],
      ...(process.platform === "win32" ? { filters: [{ name: "pandoc", extensions: ["exe"] }] } : {}),
    };
    const picked = window === null ? await dialog.showOpenDialog(dialogOptions) : await dialog.showOpenDialog(window, dialogOptions);
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { kind: "cancelled" };
    const probe = await options.probe.probeExact(path);
    if (probe === null) {
      return {
        kind: "invalid",
        path,
        message: `This file does not run as pandoc: ${path}. Pick the pandoc executable (pandoc.exe on Windows).`,
      };
    }
    return { kind: "ok", path, probe };
  });

  ipcMain.handle(docxExportChannels.pickTemplate, async (): Promise<DocxTemplatePickOutcome> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Select a Word template (.docx)",
      properties: ["openFile"],
      filters: [{ name: "Word template", extensions: ["docx"] }],
    };
    const picked = window === null ? await dialog.showOpenDialog(dialogOptions) : await dialog.showOpenDialog(window, dialogOptions);
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { kind: "cancelled" };
    const report = await inspectFile(path, "custom");
    if (!report.ok) return { kind: "invalid", path, report };
    await options.settings.write({ docxTemplateMode: "custom", docxTemplatePath: path });
    return { kind: "ok", report };
  });
}

async function inspectFile(path: string, requested: "custom" | "default" | "project"): Promise<DocxTemplateReport> {
  try {
    const bytes = await readFile(path);
    return await inspectDocxTemplate(bytes, { requested, path });
  } catch (cause) {
    return {
      requested,
      path,
      ok: false,
      verdict: "unusable",
      summary: `Template not found or unreadable: ${path}`,
      findings: [
        {
          level: "warn",
          label: "Template not found or unreadable",
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    };
  }
}

/** 内置默认模板：要 pandoc 现生成（缓存命中就不起进程） */
async function inspectDefault(options: DocxExportIpcOptions, pandocPath: string | undefined): Promise<DocxTemplateReport> {
  const probe = await options.probe.probe(pandocPath);
  if (!probe.ok || probe.path === null || probe.version === null) {
    return {
      requested: "default",
      path: null,
      ok: false,
      verdict: "unusable",
      summary: "The built-in template needs pandoc. " + probe.message,
      findings: [{ level: "warn", label: "pandoc is not available" }],
    };
  }
  const made = await ensureDefaultTemplate({
    cacheDir: options.cacheDir,
    pandocPath: probe.path,
    version: probe.version,
    printReference: options.printReference,
  });
  if (made.path === null) {
    return {
      requested: "default",
      path: null,
      ok: false,
      verdict: "unusable",
      summary: `Could not prepare the built-in template: ${made.error ?? "unknown error"}`,
      findings: [{ level: "warn", label: "Built-in template unavailable", ...(made.error === null ? {} : { detail: made.error }) }],
    };
  }
  return inspectFile(made.path, "default");
}
