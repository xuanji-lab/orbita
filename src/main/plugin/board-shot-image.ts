/**
 * 看板截图的内容 sanity check：空白外框不能进缓存。
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
