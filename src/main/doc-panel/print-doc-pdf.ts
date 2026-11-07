/**
 * 文档 → PDF 的打印（electron 一侧）：隐藏窗口加载自包含 HTML（`doc-html.ts`），`printToPDF`。
 * 与 `export-pdf.ts`（演示文稿）同一套安全姿态：HTML 写临时文件再 `loadFile`、沙盒、**禁用脚本**、不许导航 / 开新窗。
 * A4、边距由 HTML 里的 `@page` 说了算（`preferCSSPageSize`）。
 */
import { BrowserWindow } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function printDocPdf(html: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-doc-"));
  const file = join(dir, "doc.html");
  let window: BrowserWindow | null = null;
  try {
    await writeFile(file, html, "utf8");
    window = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadFile(file);
    return await window.webContents.printToPDF({ pageSize: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    window?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
