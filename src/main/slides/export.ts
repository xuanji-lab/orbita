/**
 * 演示文稿导出的实现（主进程）：菜单点导出（`ipc.ts`）与 agent 的 `slides_export`（`agent-requests.ts`）
 * 共用这一处。契约在 `shared/slides-export.ts`。
 *
 * - pdf / png：隐藏窗口加载 `renderDeckDocument` 的静态 HTML（**禁用脚本**）再 printToPDF / capturePage；
 *   渲染与画布 / 缩略图 / 播放共用 `shared/slides-render.ts`，所以「导出来歪」不会发生；
 * - html：同一份渲染 + 翻页脚本，图片内联成 data URI → 单文件、断网能开；
 * - pptx / pptx-basic：`pptx.ts` 逐元素映射。
 * 图片只从演示文稿自己所在目录读（realpath 之后仍须落在该目录内，堵 symlink 逃逸），单张 ≤ 30 MB。
 */
import { BrowserWindow } from "electron";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IMAGE_MIME, readImageInfo } from "../../shared/image-size.ts";
import type { SlidesExportFormat } from "../../shared/slides-export.ts";
import { CANVAS_SIZE, DECK_MAX_BYTES, parseDeck, type Deck } from "../../shared/slides.ts";
import { renderDeckDocument } from "../../shared/slides-render.ts";
import { printSlidesPdf } from "../doc-panel/export-pdf.ts";
import { realpathInside } from "../path-boundary.ts";
import { buildPptx, type PptxAsset } from "./pptx.ts";

const ASSET_MAX_BYTES = 30 * 1024 * 1024;

export async function loadDeck(realPath: string): Promise<Deck> {
  const info = await stat(realPath);
  if (info.size > DECK_MAX_BYTES) throw new Error(`演示文稿文件太大（${info.size} 字节）`);
  return parseDeck(await readFile(realPath, "utf8")).deck;
}

/** 读 deck 里引用到的全部图片；读不到的不进表（导出时画占位，不让一张坏图拦住整份导出） */
export async function loadAssets(deck: Deck, deckDir: string): Promise<Map<string, PptxAsset>> {
  const assets = new Map<string, PptxAsset>();
  for (const slide of deck.slides) {
    for (const element of slide.elements) {
      if (element.kind !== "image" || assets.has(element.src)) continue;
      const real = await realpathInside(join(deckDir, element.src), [deckDir]);
      if (real === null) continue;
      try {
        const size = (await stat(real)).size;
        if (size > ASSET_MAX_BYTES) continue;
        const bytes = new Uint8Array(await readFile(real));
        assets.set(element.src, { bytes, info: readImageInfo(bytes) });
      } catch {
        // 读不了：当没有
      }
    }
  }
  return assets;
}

function dataUriOf(asset: PptxAsset): string {
  const mime = asset.info === null ? "application/octet-stream" : IMAGE_MIME[asset.info.format];
  return `data:${mime};base64,${Buffer.from(asset.bytes).toString("base64")}`;
}

/** 整页放大 2 倍后截图：窗口宽 = 画布宽 × 2，输出恰好 2× 分辨率（Retina 屏上截到更大时缩回来） */
async function capturePng(html: string, width: number, height: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-slides-png-"));
  const file = join(dir, "slide.html");
  let window: BrowserWindow | null = null;
  try {
    await writeFile(file, html, "utf8");
    window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadFile(file);
    // 给一帧时间让图片解码上屏
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    const size = image.getSize();
    const out = size.width === width ? image : image.resize({ width, height, quality: "best" });
    return out.toPNG();
  } finally {
    window?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}

export interface ExportedDeck {
  bytes: Uint8Array;
  pages: number;
}

/**
 * 导出一份演示文稿。page（1 起）只对 png 有意义，越界报错。
 * deckPath 必须已经过白名单（调用方负责）；这里只信它所在的目录。
 */
export async function exportDeck(deckPath: string, format: SlidesExportFormat, page?: number): Promise<ExportedDeck> {
  const deck = await loadDeck(deckPath);
  const deckDir = dirname(deckPath);
  const assets = await loadAssets(deck, deckDir);
  const ctx = {
    deck,
    imageUrl: (src: string): string | null => {
      const asset = assets.get(src);
      return asset === undefined ? null : dataUriOf(asset);
    },
  };
  switch (format) {
    case "html":
      return { bytes: Buffer.from(renderDeckDocument(deck, ctx, "web"), "utf8"), pages: deck.slides.length };
    case "pdf":
      if (deck.slides.length === 0) throw new Error("演示文稿没有页，无法导出 PDF");
      return { bytes: await printSlidesPdf(renderDeckDocument(deck, ctx, "print"), deck.slides.length), pages: deck.slides.length };
    case "png": {
      const n = page ?? 1;
      if (!Number.isInteger(n) || n < 1 || n > deck.slides.length) {
        throw new Error(`没有第 ${String(n)} 页（共 ${deck.slides.length} 页，页号从 1 起）`);
      }
      const canvas = CANVAS_SIZE[deck.aspect];
      const bytes = await capturePng(renderDeckDocument(deck, ctx, "png", n - 1), canvas.w * 2, canvas.h * 2);
      return { bytes, pages: 1 };
    }
    case "pptx":
    case "pptx-basic":
      return { bytes: await buildPptx(deck, { basicFonts: format === "pptx-basic", assets }), pages: deck.slides.length };
  }
}
