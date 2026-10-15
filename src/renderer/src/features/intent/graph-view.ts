/**
 * 意图图的视图变换（缩放 / 平移）与语义缩放档位 —— 纯函数，`node --test` 可直接加载。
 *
 * 缩放和平移**只改视图变换**：不碰布局坐标、不碰坐标缓存、不触发模拟。
 * 屏幕坐标 = 基础映射（布局空间 → 面板，等比居中：`ox + x·k`）再叠一层视图变换
 * （`·z + tx`），两层合成一个 Mapping 给绘制用。
 */

/** 布局空间 → 屏幕的仿射映射（等比）。 */
export interface Mapping {
  k: number;
  ox: number;
  oy: number;
}

/** 视图变换：以屏幕左上为原点的缩放倍数与平移（屏幕 px）。 */
export interface ViewTransform {
  z: number;
  tx: number;
  ty: number;
}

export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 4;
export const IDENTITY_VIEW: ViewTransform = { z: 1, tx: 0, ty: 0 };

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

/** 基础映射（短边贴合、居中）。 */
export function baseMapping(space: { w: number; h: number }, view: { w: number; h: number }): Mapping {
  const k = Math.min(view.w / space.w, view.h / space.h);
  return { k, ox: (view.w - space.w * k) / 2, oy: (view.h - space.h * k) / 2 };
}

/** 基础映射 ⊕ 视图变换 → 绘制用的合成映射。 */
export function composeMapping(base: Mapping, view: ViewTransform): Mapping {
  return { k: base.k * view.z, ox: base.ox * view.z + view.tx, oy: base.oy * view.z + view.ty };
}

/**
 * 围绕屏幕上一点缩放：该点在缩放前后指向同一个布局坐标（指针下的东西不动）。
 * 倍数先钳到 [ZOOM_MIN, ZOOM_MAX]；撞到边界时按实际倍率算平移，不会漂。
 */
export function zoomAround(view: ViewTransform, factor: number, px: number, py: number): ViewTransform {
  const z = clampZoom(view.z * factor);
  const ratio = z / view.z;
  return { z, tx: px - (px - view.tx) * ratio, ty: py - (py - view.ty) * ratio };
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { z: view.z, tx: view.tx + dx, ty: view.ty + dy };
}

/** 滚轮 → 缩放倍数：普通滚轮一格约 ×1.1；触控板捏合（ctrlKey）deltaY 小而密，用更陡的曲线。 */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  const clamped = Math.max(-100, Math.min(100, deltaY));
  return Math.exp(-clamped * (pinch ? 0.01 : 0.002));
}

/**
 * 语义缩放档位（按叶子在屏幕上的放大倍率，即合成映射的 k）：
 * 0 = 常规；1 = 中度放大（每片叶标轮号 + 短标题）；2 = 大幅放大（再加分数与一句
 * 联系，所有簇心显全名）。密集模式阈值抬高一点，免得标签互相压住。
 */
export type LabelTier = 0 | 1 | 2;

export function labelTier(scale: number, dense: boolean): LabelTier {
  const t1 = dense ? 1.7 : 1.5;
  const t2 = dense ? 2.8 : 2.5;
  if (scale >= t2) return 2;
  if (scale >= t1) return 1;
  return 0;
}

/** 截到 n 个字符，截了就加省略号（中文一字一格，不按字节）。 */
export function clipText(text: string, n: number): string {
  const chars = [...text.trim().replace(/\s+/g, " ")];
  if (chars.length <= n) return chars.join("");
  return `${chars.slice(0, n).join("")}…`;
}
