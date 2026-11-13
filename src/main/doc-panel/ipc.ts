/**
 * 文档面板的 IPC —— 四层契约的第 2 层（契约在 `shared/doc.ts`，实做在 `service.ts`）。
 * 白名单与文件面板同一套：根每次现算（`resolveFileRoots`），路径 realpath 后必须在可写根之内。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { basename, dirname, join } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  type DocChangedEvent,
  type DocCreated,
  type DocCreateRequest,
  type DocExportDocRequest,
  type DocExportRequest,
  type DocExportResult,
  type DocInsertImageRequest,
  type DocInserted,
  type OfmResolved,
  type OfmResolveRequest,
  type DocSaveAsRequest,
  type DocSaveAsResult,
  type DocFile,
  type DocListEntry,
  type DocListRequest,
  type DocTarget,
  type DocWriteRequest,
  type DocWriteResult,
} from "../../shared/doc.ts";
import { writeBytesAtomic, writeTextAtomic } from "../atomic-write.ts";
import { realpathInside } from "../path-boundary.ts";
import { resolveFileRoots } from "../files/roots.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { buildDocExport } from "./doc-export.ts";
import { resolveTargets, saveAttachment } from "./ofm-files.ts";
import { printDocPdf } from "./print-doc-pdf.ts";
import { printSlidesPdf } from "./export-pdf.ts";
import { createDoc, DocWatchers, listDocs, normalizeNewlines, readDoc, resolveDocPath, writeDoc } from "./service.ts";

export function registerDocIpc(workspaces: WorkspaceStore, sessions: SessionStore): void {
  const watchers = new DocWatchers();
  const rootsOf = (req: { sessionId: string | null; workspaceId: string | null }) =>
    resolveFileRoots(workspaces, sessions, { sessionId: req.sessionId, workspaceId: req.workspaceId });

  ipcMain.handle(ipcChannels.docRead, async (_event, req: DocTarget): Promise<DocFile> =>
    readDoc(await rootsOf(req), req.path),
  );

  ipcMain.handle(ipcChannels.docWrite, async (_event, req: DocWriteRequest): Promise<DocWriteResult> =>
    writeDoc(await rootsOf(req), req),
  );

  ipcMain.handle(ipcChannels.docCreate, async (_event, req: DocCreateRequest): Promise<DocCreated> =>
    createDoc(await rootsOf(req), req),
  );

  ipcMain.handle(ipcChannels.docList, async (_event, req: DocListRequest): Promise<DocListEntry[]> =>
    listDocs(await rootsOf(req)),
  );

  ipcMain.handle(ipcChannels.docWatch, async (event, req: DocTarget): Promise<void> => {
    const real = await resolveDocPath(await rootsOf(req), req.path);
    const sender = event.sender;
    const prefix = `${sender.id}:`;
    await watchers.watch(`${prefix}${real}`, real, () => {
      if (sender.isDestroyed()) return;
      const payload: DocChangedEvent = { path: req.path };
      sender.send(ipcChannels.docChanged, payload);
    });
    // 窗口关了就收掉这个窗口的全部监听（只挂一次）
    if (!closing.has(sender.id)) {
      closing.add(sender.id);
      sender.once("destroyed", () => {
        closing.delete(sender.id);
        watchers.unwatchPrefix(prefix);
      });
    }
  });

  ipcMain.handle(ipcChannels.docUnwatch, async (event, req: DocTarget): Promise<void> => {
    // 解除不需要白名单（只是关自己开的 watcher）；路径解析不了就按原样当 key 试一次
    const real = await resolveDocPath(await rootsOf(req), req.path).catch(() => req.path);
    watchers.unwatch(`${event.sender.id}:${real}`);
  });

  ipcMain.handle(ipcChannels.docSaveAs, async (event, req: DocSaveAsRequest): Promise<DocSaveAsResult> => {
    const roots = await rootsOf(req);
    const window = BrowserWindow.fromWebContents(event.sender);
    const name = basename(req.path).replace(/\.md$/i, "");
    const options = {
      // 原文件被删时 dirname 仍是它原来的目录（工作区里）；只当默认值，用户想存哪都行
      defaultPath: join(dirname(req.path), `${name} 副本.md`),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const picked = await (window === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(window, options));
    if (picked.canceled || picked.filePath === "") return { saved: null, inside: false };
    const target = /\.md$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.md`;
    await writeTextAtomic(target, normalizeNewlines(req.text));
    const allowed = roots.filter((root) => root.exists && root.kind !== "attachments").map((root) => root.path);
    return { saved: target, inside: (await realpathInside(target, allowed)) !== null };
  });

  ipcMain.handle(ipcChannels.docExport, async (event, req: DocExportRequest): Promise<DocExportResult> => {
    const real = await resolveDocPath(await rootsOf(req), req.path);
    const window = BrowserWindow.fromWebContents(event.sender);
    const title = basename(real).replace(/\.md$/i, "");
    // 先生成再问存哪：生成失败则不必打扰用户弹对话框
    const bytes = await printSlidesPdf(req.html, req.pages);
    const options = {
      defaultPath: join(dirname(real), `${title}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const picked = await (window === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(window, options));
    if (picked.canceled || picked.filePath === "") return { saved: null };
    await writeBytesAtomic(picked.filePath, bytes);
    return { saved: picked.filePath };
  });

  // 文档导出：docx / pdf / md / 通用 md。生成函数与 agent 的 doc_export 共用（doc-export.ts）
  ipcMain.handle(ipcChannels.docExportDoc, async (event, req: DocExportDocRequest): Promise<DocExportResult> => {
    const roots = await rootsOf(req);
    const real = await resolveDocPath(roots, req.path);
    const window = BrowserWindow.fromWebContents(event.sender);
    const title = basename(real).replace(/\.(?:md|markdown|txt)$/i, "");
    const text = req.text ?? (await readDoc(roots, real)).text;
    const built = await buildDocExport({ format: req.format, text, docReal: real, roots, title, printPdf: printDocPdf });
    const suffix = req.format === "md-plain" ? " (通用)" : "";
    const options = {
      defaultPath: join(dirname(real), `${title}${suffix}.${built.ext}`),
      filters: [{ name: built.ext.toUpperCase(), extensions: [built.ext] }],
    };
    const picked = await (window === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(window, options));
    if (picked.canceled || picked.filePath === "") return { saved: null };
    await writeBytesAtomic(picked.filePath, built.bytes);
    return { saved: picked.filePath };
  });

  ipcMain.handle(ipcChannels.docOfmResolve, async (_event, req: OfmResolveRequest): Promise<OfmResolved[]> => {
    const roots = await rootsOf(req);
    // 文档本身要过白名单；找不到文档（刚被移走）就当全部解析不到，不抛——阅读视图仍能画出文字
    const real = await resolveDocPath(roots, req.path).catch(() => null);
    if (real === null) return req.items.map(() => null);
    return resolveTargets(roots, real, req.items.slice(0, 500));
  });

  ipcMain.handle(ipcChannels.docInsertImage, async (event, req: DocInsertImageRequest): Promise<DocInserted | null> => {
    const roots = await rootsOf(req);
    const real = await resolveDocPath(roots, req.path);
    if (req.source.kind === "bytes") {
      return saveAttachment(roots, real, { kind: "bytes", name: req.source.name, bytes: Buffer.from(req.source.base64, "base64") });
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ["openFile" as const],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }],
    };
    const picked = await (window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options));
    const file = picked.filePaths[0];
    if (picked.canceled || file === undefined) return null;
    return saveAttachment(roots, real, { kind: "file", path: file });
  });
}

/** 已挂过「窗口销毁就清监听」的窗口 */
const closing = new Set<number>();
