/**
 * 演示文稿 → PDF：renderer 渲好整份幻灯片的自包含 HTML（每页一个 `.slide`，1280×720 CSS 像素 =
 * 16:9），这里用一个**隐藏窗口**加载、`printToPDF`。
 *
 * - HTML 写临时文件再 `loadFile`（data: URL 有体积上限，几十页带样式的幻灯片会超）；
 * - 窗口 `show: false`、沙盒、**禁用脚本**：HTML 来自 renderer 的 markdown 管线（已 sanitize），
 *   导出只需要静态排版，不给它执行任何东西的机会；
 * - 页面尺寸 13.333 × 7.5 英寸（= 1280 × 720 px @96dpi），边距 0，`preferCSSPageSize` 让
 *   HTML 里的 `@page` 说了算；每页 `break-after: page`（末页不加，免得多出一张空白页）；
 * - 做完核一遍 PDF 里的页数 = 分页数，不对就报错、不落一份错的 PDF。
 */
import { BrowserWindow } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** PDF 字节里的页数：数 `/Type /Page`（不含 `/Pages`）。Chromium 的 PDF 页对象是明文字典 */
export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/** 16:9 的页面尺寸（英寸） */
export const SLIDE_PAGE_INCHES = { width: 13.333, height: 7.5 } as const;

export async function printSlidesPdf(html: string, pages: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-slides-"));
  const file = join(dir, "slides.html");
  let window: BrowserWindow | null = null;
  try {
    await writeFile(file, html, "utf8");
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false },
    });
    // 导出页不许导航走、不许开新窗
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadFile(file);
    const pdf = await window.webContents.printToPDF({
      pageSize: SLIDE_PAGE_INCHES,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: true,
    });
    const counted = countPdfPages(pdf);
    if (counted !== pages) {
      throw new Error(`导出的 PDF 有 ${counted} 页，演示文稿有 ${pages} 页——没有保存`);
    }
    return pdf;
  } finally {
    window?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
