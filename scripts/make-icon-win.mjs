/**
 * Windows 图标：`Orbita Design System/assets/app-icon.svg` → `build/icon.png`（1024²）。
 *
 * 两张图，同一个源：
 * - `build/icon.png`（1024²）：Windows / NSIS 的应用图标。与 `scripts/make-icon.sh`
 *   （macOS 的 .icns，走 swift / sips / iconutil）分工；Windows 只要一张 ≥256² 的 PNG，
 *   electron-builder 自己转成 .ico——不手写 ICO 容器，少一段只在图标路径上跑的字节
 *   拼接，就少一处能悄悄错的地方。
 * - `build/tray.png`（32²）：关窗收进托盘后的那个图标（主进程读它，见 `window/tray.ts`；
 *   打包时由 electron-builder 的 extraResources 复制到 resources/）。
 *
 * 用仓里已有的 @napi-rs/canvas 光栅化（它带 SVG 支持），因此这个脚本在任何平台都能跑，
 * 不挑 macOS。两张派生产物均入库（与 `build/icon.icns` 同样待遇），
 * 改品牌图形时重跑：`bun run icon:win`。
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "Orbita Design System", "assets", "app-icon.svg");
const target = join(root, "build", "icon.png");
const trayTarget = join(root, "build", "tray.png");

/** Windows 图标要 256 及以上，这里取 1024（与 SVG 的 viewBox 同尺寸，不缩放） */
const SIZE = 1024;
/** 托盘按 16×16 逻辑尺寸显示，200% 缩放的屏幕用 32×32 */
const TRAY_SIZE = 32;

const image = await loadImage(readFileSync(source));
const canvas = createCanvas(SIZE, SIZE);
const context = canvas.getContext("2d");
context.drawImage(image, 0, 0, SIZE, SIZE);
writeFileSync(target, canvas.toBuffer("image/png"));
console.log(`build/icon.png 已更新（${SIZE}×${SIZE}）`);

const trayCanvas = createCanvas(TRAY_SIZE, TRAY_SIZE);
const trayContext = trayCanvas.getContext("2d");
trayContext.drawImage(image, 0, 0, TRAY_SIZE, TRAY_SIZE);
writeFileSync(trayTarget, trayCanvas.toBuffer("image/png"));
console.log(`build/tray.png 已更新（${TRAY_SIZE}×${TRAY_SIZE}）`);
