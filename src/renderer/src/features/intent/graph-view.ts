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

/** 缩小的下限：布局没有边界之后，几百个节点的图要能整张缩进面板（真机 300+ 节点约 0.3×） */
export const ZOOM_MIN = 0.15;
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
 * -1 = 总览（缩小看全图：文字不随倍率缩小，几十个簇名会挤成一团字，只留岗位名与
 *      提问中心）；0 = 常规；1 = 中度放大（每片叶标轮号 + 短标题）；2 = 大幅放大
 * （再加分数与一句联系，所有簇心显全名）。密集模式阈值抬高一点，免得标签互相压住。
 */
export type LabelTier = -1 | 0 | 1 | 2;

/** 低于这个屏幕倍率进总览档（布局去掉边界后，大图适配下来通常在 0.3–0.6） */
export const OVERVIEW_SCALE = 0.75;

export function labelTier(scale: number, dense: boolean): LabelTier {
  const t1 = dense ? 1.7 : 1.5;
  const t2 = dense ? 2.8 : 2.5;
  if (scale < OVERVIEW_SCALE) return -1;
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

/**
 * 适配：把节点外接框（布局空间）整张放进面板，四周留边距（标签要留得下），居中。
 * 只缩小不放大（倍数封顶 1）——节点少时保持自然大小，不把十几个点撑满屏幕；
 * 结果在 [ZOOM_MIN, 1] 内。外接框退化（单点 / 一条线）时按 1 居中。
 */
/** 面板四边被浮在图上的控件占掉的距离（px）：顶上的视图切换与摘要、底部的图例。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export function fitView(
  bounds: { x0: number; y0: number; x1: number; y1: number },
  base: Mapping,
  viewport: { w: number; h: number },
  pad: number,
  insets: Insets = NO_INSETS,
): ViewTransform {
  const bw = (bounds.x1 - bounds.x0) * base.k;
  const bh = (bounds.y1 - bounds.y0) * base.k;
  // 可用区 = 面板扣掉浮层控件，再四周留 pad；浮层太大时至少留 1px 不除零
  const left = insets.left + pad;
  const top = insets.top + pad;
  const availW = Math.max(1, viewport.w - insets.left - insets.right - pad * 2);
  const availH = Math.max(1, viewport.h - insets.top - insets.bottom - pad * 2);
  const z = clampZoom(Math.min(1, bw > 0 ? availW / bw : 1, bh > 0 ? availH / bh : 1));
  // 外接框中心（基础映射下的屏幕坐标）落到可用区中心
  const cx = base.ox + ((bounds.x0 + bounds.x1) / 2) * base.k;
  const cy = base.oy + ((bounds.y0 + bounds.y1) / 2) * base.k;
  return { z, tx: left + availW / 2 - cx * z, ty: top + availH / 2 - cy * z };
}

/** 适配留的边距：面板短边的 8%，至少 24px（簇名标签在节点外侧）。 */
export function fitPadding(viewport: { w: number; h: number }): number {
  return Math.max(24, Math.min(viewport.w, viewport.h) * 0.08);
}
