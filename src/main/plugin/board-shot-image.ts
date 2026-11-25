/**
 * 看板截图（`board:shot`）在主进程里的两段纯逻辑：视口大小的解析、内容 sanity check。
 * nativeImage.toBitmap 是 BGRA；每 16 个像素取一个样本，避免每块看板都全图扫描。
 */
import type { NativeImage } from "electron";

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
export function boardImagePainted(image: NativeImage): boolean {
  return luminanceDeviation(image.toBitmap()) >= 12;
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
