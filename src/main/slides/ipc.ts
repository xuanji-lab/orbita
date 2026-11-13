/**
 * 演示文稿 v2 的 IPC —— 四层契约的第 2 层（契约在 `shared/slides-export.ts`）。
 * 白名单与文档面板同一套（`resolveFileRoots` + realpath 后必须在可写根内）。
 * 导出的实现在 `export.ts`，与 agent 的 slides_export 共用。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { IMAGE_MIME, readImageInfo } from "../../shared/image-size.ts";
import {
  SLIDES_EXPORT_EXT,
  isSlidesExportFormat,
  type SlidesAddAssetRequest,
  type SlidesAddedAsset,
  type SlidesAssetBytes,
  type SlidesConvertRequest,
  type SlidesConverted,
  type SlidesExportRequest,
  type SlidesExportResult,
  type SlidesReadAssetRequest,
} from "../../shared/slides-export.ts";
import { collectMarpImages, marpToDeck, type ConvertedImage } from "../../shared/slides-marp.ts";
import { safeRelativePath, serializeDeck } from "../../shared/slides.ts";
import { errorCode } from "../fs-errors.ts";
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

  ipcMain.handle(ipcChannels.slidesConvertMarp, async (_event, req: SlidesConvertRequest): Promise<SlidesConverted> => {
    const roots = await rootsOf(req);
    const source = await resolveDocPath(roots, req.path);
    if (!/\.md$/i.test(source)) throw new Error("只能转换 .md 演示文稿");
    const text = await readFile(source, "utf8");
    const stem = basename(source).replace(/\.md$/i, "");
    const dir = dirname(source);
    const allowed = roots.filter((root) => root.exists && root.kind !== "attachments").map((root) => root.path);
    // 先占住新文件名（wx 独占创建，重名加序号），assets 目录名跟着它走
    let target = "";
    for (let n = 1; n < 1000; n += 1) {
      const candidate = join(dir, `${n === 1 ? stem : `${stem} ${n}`}.slides.json`);
      try {
        const handle = await open(candidate, "wx");
        await handle.close();
        target = candidate;
        break;
      } catch (cause) {
        if (errorCode(cause) !== "EEXIST") throw cause;
      }
    }
    if (target === "") throw new Error("同名演示文稿太多，换个名字再转");
    const images = new Map<string, ConvertedImage>();
    for (const src of collectMarpImages(text)) {
      const path = resolve(isAbsolute(src) ? src : join(dir, src));
      const real = await realpathInside(path, allowed);
      if (real === null) continue; // 找不到 / 在工作区外：转换结果里留一行文字说明
      try {
        const saved = await saveAssetBytes(target, basename(real), new Uint8Array(await readFile(real)));
        images.set(src, { src: saved.src, width: saved.info.width, height: saved.info.height });
      } catch {
        // 不是图片 / 太大：同上
      }
    }
    const deck = marpToDeck(text, stem, images);
    await writeBytesAtomic(target, Buffer.from(serializeDeck(deck), "utf8"));
    return { path: target, pages: deck.slides.length };
  });

  ipcMain.handle(ipcChannels.slidesAddAsset, async (_event, req: SlidesAddAssetRequest): Promise<SlidesAddedAsset> => {
    const deck = await resolveDocPath(await rootsOf(req), req.path);
    const saved = await saveAssetBytes(deck, req.name, req.bytes);
    return { src: saved.src, width: saved.info.width, height: saved.info.height };
  });
}
