/**
 * Windows 图标：`Orbita Design System/assets/app-icon.svg` → `build/icon.png`（1024²）。
 *
 * 与 `scripts/make-icon.sh`（macOS 的 .icns，走 swift / sips / iconutil）分工：
 * Windows / NSIS 只要一张 ≥256² 的 PNG，electron-builder 自己转成 .ico；所以这里
 * 不手写 ICO 容器——少一段只在图标路径上跑的字节拼接，就少一处能悄悄错的地方。
 *
 * 用仓里已有的 @napi-rs/canvas 光栅化（它带 SVG 支持），因此这个脚本在任何平台都能跑，
 * 不挑 macOS。派生产物 `build/icon.png` 入库（与 `build/icon.icns` 同样待遇），
 * 改品牌图形时重跑：`bun run icon:win`。
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "Orbita Design System", "assets", "app-icon.svg");
const target = join(root, "build", "icon.png");

/** Windows 图标要 256 及以上，这里取 1024（与 SVG 的 viewBox 同尺寸，不缩放） */
const SIZE = 1024;

const image = await loadImage(readFileSync(source));
const canvas = createCanvas(SIZE, SIZE);
const context = canvas.getContext("2d");
context.drawImage(image, 0, 0, SIZE, SIZE);
writeFileSync(target, canvas.toBuffer("image/png"));
console.log(`build/icon.png 已更新（${SIZE}×${SIZE}）`);
