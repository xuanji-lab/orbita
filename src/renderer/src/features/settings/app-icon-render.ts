/**
 * 应用图标的栅格化：SVG → 512×512 PNG（renderer 画，主进程只接字节，见 shared/app-icon.ts）。
 *
 * 为什么由我们画而不是交给系统：macOS 的 `app.dock.setIcon` 不会替图标加圆角与留白，
 * 直接塞满铺方形，Dock 里就是一块比邻居大一圈的方块。所以按 macOS 图标网格画好：
 * 1024 画布里 824 的圆角卡居中，四周留给系统式投影（与 scripts/icon/render-icon.swift 打包
 * 图标的参数同源）。Windows / Linux 的任务栏图标直接用满铺方形，不画圆角。
 *
 * 本文件只含纯几何（node --test 可测）与 canvas 绘制；SVG 的取用在 app-icon-assets.ts。
 */
import { APP_ICON_PNG_SIZE } from "../../../../shared/app-icon.ts";

/** 一张图标在画布上的摆放：卡的左上角（x = y = inset）、边长、圆角半径与投影 */
export interface IconGrid {
  inset: number;
  side: number;
  radius: number;
  /** null = 不画投影（满铺方形） */
  shadow: { blur: number; offsetY: number; alpha: number } | null;
}

/** macOS 图标网格（1024 基准）：824 的卡居中、圆角 232 × 824/1024 ≈ 186.7，与打包图标一致 */
const MAC_GRID = { canvas: 1024, card: 824, radius: (232 * 824) / 1024, blur: 24, offsetY: 10, alpha: 0.28 } as const;

/** 平台 → 摆放。darwin 走 macOS 网格，其余（win32 / linux）满铺方形 */
export function appIconGrid(platform: string, size: number = APP_ICON_PNG_SIZE): IconGrid {
  if (platform !== "darwin") return { inset: 0, side: size, radius: 0, shadow: null };
  const scale = size / MAC_GRID.canvas;
  return {
    inset: ((MAC_GRID.canvas - MAC_GRID.card) / 2) * scale,
    side: MAC_GRID.card * scale,
    radius: MAC_GRID.radius * scale,
    shadow: { blur: MAC_GRID.blur * scale, offsetY: MAC_GRID.offsetY * scale, alpha: MAC_GRID.alpha },
  };
}

/** 给 SVG 根补上显式宽高：只有 viewBox 的 SVG 当图片解码时固有尺寸不定，画到 canvas 上要明确 */
export function sizedSvg(svg: string, size: number): string {
  return svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
}

/** 圆角矩形路径（半径 0 时就是直角矩形） */
function roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, side: number, radius: number): void {
  context.beginPath();
  if (radius > 0) context.roundRect(x, y, side, side, radius);
  else context.rect(x, y, side, side);
}

/** 把一份 SVG 文本画成 PNG 字节；platform 取 `api.platform`（"darwin" / "win32" / …） */
export async function renderAppIconPng(svg: string, platform: string): Promise<Uint8Array> {
  const size = APP_ICON_PNG_SIZE;
  const grid = appIconGrid(platform, size);
  // data: URL 的 SVG 图片不会弄脏 canvas（blob / 文件 URL 在 file:// 来源下会，toBlob 就抛 SecurityError）
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedSvg(svg, size))}`;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("canvas 不可用");

  if (grid.shadow !== null) {
    // 先单独画一层带投影的底卡；图案盖在上面，投影只露在卡外
    context.save();
    context.shadowColor = `rgba(0, 0, 0, ${grid.shadow.alpha})`;
    context.shadowBlur = grid.shadow.blur;
    context.shadowOffsetY = grid.shadow.offsetY;
    context.fillStyle = "black";
    roundedRectPath(context, grid.inset, grid.inset, grid.side, grid.radius);
    context.fill();
    context.restore();
  }
  context.save();
  roundedRectPath(context, grid.inset, grid.inset, grid.side, grid.radius);
  context.clip();
  context.drawImage(image, grid.inset, grid.inset, grid.side, grid.side);
  context.restore();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob === null) throw new Error("canvas 导出 PNG 失败");
  return new Uint8Array(await blob.arrayBuffer());
}
