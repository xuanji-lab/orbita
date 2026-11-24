/**
 * 无脸地表图 → 只留那颗球（纯计算，可直测）。Qwen 出的地表是透明底上的一颗球，球不一定居中（提示词让它略偏左下），
 * 四周还有零星半透明噪点，有的还自带一圈星环。按 alpha 取「足够不透明」的像素的外框，再以外框中心为心、短边为边取正方形——
 * 界面拿这块正方形当贴图塞进代码画的圆里，球缘与圆缘对齐。
 */

/** 不透明度门槛：低于它的像素（羽化边、噪点）不算球 */
export const SPHERE_ALPHA = 200;
/** 一行 / 一列里至少要有这么多不透明像素才算进外框（滤掉孤立噪点） */
export const SPHERE_MIN_RUN = 3;

export interface CropBox {
  x: number;
  y: number;
  size: number;
}

/**
 * bitmap：RGBA 或 BGRA 都行（只读第 4 个字节）。找不到球（几乎全透明）或图本来就没有透明底（全不透明）时
 * 返回整张图的正方形（不裁）。
 */
export function sphereCrop(bitmap: Uint8Array, width: number, height: number): CropBox {
  const whole: CropBox = { x: 0, y: 0, size: Math.min(width, height) };
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return whole;
  const rows = new Array<number>(height).fill(0);
  const cols = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((bitmap[(y * width + x) * 4 + 3] ?? 0) >= SPHERE_ALPHA) {
        rows[y] = (rows[y] ?? 0) + 1;
        cols[x] = (cols[x] ?? 0) + 1;
      }
    }
  }
  const first = (list: number[]): number => list.findIndex((count) => count >= SPHERE_MIN_RUN);
  const last = (list: number[]): number => {
    for (let i = list.length - 1; i >= 0; i--) if ((list[i] ?? 0) >= SPHERE_MIN_RUN) return i;
    return -1;
  };
  const y0 = first(rows);
  const y1 = last(rows);
  const x0 = first(cols);
  const x1 = last(cols);
  if (y0 < 0 || x0 < 0) return whole;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  // 全不透明（没有透明底）：外框就是整张图，不裁
  if (w >= width && h >= height) return whole;
  // 球是圆的：外框的短边就是球径。长边更长只会是 Qwen 顺手画上的星环（横向伸出去）或零星噪点——按短边取，球填满圆
  const size = Math.min(w, h, width, height);
  const cx = (x0 + x1 + 1) / 2;
  const cy = (y0 + y1 + 1) / 2;
  const x = Math.round(Math.min(Math.max(cx - size / 2, 0), width - size));
  const y = Math.round(Math.min(Math.max(cy - size / 2, 0), height - size));
  return { x, y, size: Math.round(size) };
}
