/**
 * 演示文稿 v2 的 IPC —— 四层契约的第 2 层（契约在 `shared/slides-export.ts`）。
 * 白名单与文档面板同一套（`resolveFileRoots` + realpath 后必须在可写根内）。
 * 导出的实现在 `export.ts`，与 agent 的 slides_export 共用。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { IMAGE_MIME, readImageInfo } from "../../shared/image-size.ts";
import {
  SLIDES_EXPORT_EXT,
  isSlidesExportFormat,
  type SlidesAddAssetRequest,
  type SlidesAddedAsset,
  type SlidesAssetBytes,
  type SlidesExportRequest,
  type SlidesExportResult,
  type SlidesReadAssetRequest,
} from "../../shared/slides-export.ts";
import { safeRelativePath } from "../../shared/slides.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import { resolveDocPath } from "../doc-panel/service.ts";
import { resolveFileRoots } from "../files/roots.ts";
import { realpathInside } from "../path-boundary.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { ASSET_MAX_BYTES, saveAssetBytes } from "./assets.ts";
import { exportDeck } from "./export.ts";

const FORMAT_LABEL = { pdf: "PDF", html: "网页", png: "PNG 图片", pptx: "PowerPoint", "pptx-basic": "PowerPoint" } as const;

export function registerSlidesIpc(workspaces: WorkspaceStore, sessions: SessionStore): void {
  const rootsOf = (req: { sessionId: string | null; workspaceId: string | null }) =>
    resolveFileRoots(workspaces, sessions, { sessionId: req.sessionId, workspaceId: req.workspaceId });

  ipcMain.handle(ipcChannels.slidesExport, async (event, req: SlidesExportRequest): Promise<SlidesExportResult> => {
    if (!isSlidesExportFormat(req.format)) throw new Error(`不支持的导出格式：${String(req.format)}`);
    const real = await resolveDocPath(await rootsOf(req), req.path);
    // 先生成再问存哪：生成失败不必打扰用户弹对话框
    const exported = await exportDeck(real, req.format, req.page);
    const ext = SLIDES_EXPORT_EXT[req.format];
    const stem = basename(real).replace(/\.slides\.json$/i, "");
    const suffix = req.format === "png" ? `-p${req.page ?? 1}` : req.format === "pptx-basic" ? "-basic" : "";
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: join(dirname(real), `${stem}${suffix}.${ext}`),
      filters: [{ name: FORMAT_LABEL[req.format], extensions: [ext] }],
    };
    const picked = await (window === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(window, options));
    if (picked.canceled || picked.filePath === "") return { saved: null };
    const target = picked.filePath.toLowerCase().endsWith(`.${ext}`) ? picked.filePath : `${picked.filePath}.${ext}`;
    await writeBytesAtomic(target, exported.bytes);
    return { saved: target };
  });

  ipcMain.handle(ipcChannels.slidesReadAsset, async (_event, req: SlidesReadAssetRequest): Promise<SlidesAssetBytes> => {
    const deck = await resolveDocPath(await rootsOf(req), req.path);
    const src = safeRelativePath(req.src);
    if (src === null) throw new Error(`图片路径不合法：${req.src}`);
    const deckDir = dirname(deck);
    const real = await realpathInside(join(deckDir, src), [deckDir]);
    if (real === null) throw new Error(`找不到图片：${req.src}`);
    if ((await stat(real)).size > ASSET_MAX_BYTES) throw new Error("图片太大");
    const bytes = new Uint8Array(await readFile(real));
    const info = readImageInfo(bytes);
    if (info === null) throw new Error("不是支持的图片");
    return { bytes, mime: IMAGE_MIME[info.format] };
  });

  ipcMain.handle(ipcChannels.slidesAddAsset, async (_event, req: SlidesAddAssetRequest): Promise<SlidesAddedAsset> => {
    const deck = await resolveDocPath(await rootsOf(req), req.path);
    const saved = await saveAssetBytes(deck, req.name, req.bytes);
    return { src: saved.src, width: saved.info.width, height: saved.info.height };
  });
}
