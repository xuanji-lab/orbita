/**
 * 看板截图（`board:shot`）在主进程里的纯逻辑：视口大小的解析、整窗取帧走哪条路、裁图与内容 sanity check。
 * nativeImage.toBitmap 是 BGRA；每 16 个像素取一个样本，避免每块看板都全图扫描。
 *
 * 回给 renderer 的是裁好的原始 BGRA 像素，不编码 PNG：Mac DPR 2 实测一块 1728×1008 的看板 toPNG 要 ~143ms，
 * 全压在主进程事件循环上（Windows 上量到留图期间主进程最大卡 189ms）；toBitmap 只是一次拷贝（~15ms），
 * 而且内容检查本来就要它。传几 MB 的 Uint8Array 走 IPC 是内存拷贝，比编码便宜一个数量级，也不损画质。
 */
import type { BoardShotResult } from "../../shared/plugin-board.ts";

export function luminanceDeviation(bitmap: Uint8Array): number {
  let count = 0;
  let sum = 0;
  let square = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4 * 16) {
    const blue = bitmap[i] ?? 0;
    const green = bitmap[i + 1] ?? 0;
    const red = bitmap[i + 2] ?? 0;
    const luminance = blue * 0.114 + green * 0.587 + red * 0.299;
    count += 1;
    sum += luminance;
    square += luminance * luminance;
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.sqrt(Math.max(0, square / count - mean * mean));
}

/** 实测空白候选标准差约 5，真实看板约 33–48；留足边界，低于 12 视为还没画好 */
export function boardBitmapPainted(bitmap: Uint8Array): boolean {
  return luminanceDeviation(bitmap) >= 12;
}

/** 取帧 / 裁图用到的 nativeImage 的那几样（结构类型：测试里用假图替身） */
export interface BoardShotImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  crop(rect: { x: number; y: number; width: number; height: number }): BoardShotImage;
  toBitmap(): Uint8Array;
}

/**
 * 整窗取一帧：先原生（不给矩形——原生 capturePage(rect) 曾回局部图），回空图、尺寸对不上（只回了一部分）或抛错
 * 就丢掉它走 CDP 整页取帧；两条都不行回 null。CDP 那路的尺寸由后面的裁图校验兜住。
 */
export async function boardFullPage<T extends BoardShotImage>(
  sources: { native: () => Promise<T>; fallback: () => Promise<T | null> },
  expected: { width: number; height: number },
): Promise<{ page: T; via: "native" | "cdp" } | null> {
  try {
    const page = await sources.native();
    if (!page.isEmpty() && boardShotSizeMatches(page.getSize(), expected, 2)) return { page, via: "native" };
  } catch {
    // 换下面的 CDP 路
  }
  const page = await sources.fallback();
  return page === null ? null : { page, via: "cdp" };
}

/**
 * 从整窗帧里裁出看板那一片（rect 是 CSS 像素，ratio 是设备像素比），回原始 BGRA 像素。
 * 裁出来不是完整的期望尺寸（帧比视口小，裁到边外被截短）、像素长度对不上、或还是一片空白，都回 null：局部图绝不进缓存。
 */
export function boardShotPixels(
  page: BoardShotImage,
  rect: { x: number; y: number; width: number; height: number },
  ratio: number,
): BoardShotResult | null {
  const expected = { width: Math.round(rect.width * ratio), height: Math.round(rect.height * ratio) };
  const image = page.crop({ x: Math.round(rect.x * ratio), y: Math.round(rect.y * ratio), width: expected.width, height: expected.height });
  if (image.isEmpty() || !boardShotSizeMatches(image.getSize(), expected)) return null;
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (bitmap.byteLength !== width * height * 4 || !boardBitmapPainted(bitmap)) return null;
  // Buffer 可能是池里一段的视图：按它自己的范围包一层，IPC 只拷这一段
  return { pixels: new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength), width, height };
}

/**
 * `Page.getLayoutMetrics` 的 cssVisualViewport → 这一页此刻的视口大小（CSS 像素）。问的是调试协议而不是页面脚本：
 * 页面自己报的数不可信。形状不对、不是有限正数回 null。
 */
export function boardShotViewport(raw: unknown): { width: number; height: number } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const viewport = raw as Record<string, unknown>;
  const width = viewport["clientWidth"];
  const height = viewport["clientHeight"];
  if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 原生取帧可能只回局部：尺寸必须对上期望的物理像素，缺一条边都不能进缓存 */
export function boardShotSizeMatches(size: { width: number; height: number }, expected: { width: number; height: number }, tolerance = 1): boolean {
  return Math.abs(size.width - expected.width) <= tolerance && Math.abs(size.height - expected.height) <= tolerance;
}
