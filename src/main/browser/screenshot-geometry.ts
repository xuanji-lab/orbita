/**
 * 截图像素 ↔ 页面 CSS 像素。纯函数，可被 node --test 直接加载。
 *
 * 模型看到的截图被缩放过（Retina 上原图是 CSS 像素的 2 倍，大窗口还要再缩到 1280 宽以内），
 * 而 CDP 的鼠标事件认 CSS 像素。每次整页截图记下「图多大、对应的视口多大」，
 * 点击 / 滚动 / 局部放大拿截图坐标来时按它换算——模型只管「图上哪一点」，不用懂 DPR。
 *
 * 截图尺寸的上限：宽 1280（控 token），高 2000——pi 会把任何工具图缩到 2000 边以内
 * （afterToolCall 的 resizeImage），被它再缩一次，模型看到的像素就和这里记的对不上了。
 */

export const SHOT_MAX_WIDTH = 1280;
export const SHOT_MAX_HEIGHT = 2000;

/** 最近一次整页截图的几何：模型看到的图的尺寸，与拍摄时视口的 CSS 尺寸 */
export interface ShotGeometry {
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
}

/** 等比缩进 maxWidth × maxHeight 以内；本来就小的不放大。至少 1 像素 */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 整页截图的输出尺寸：**以 CSS 视口为准**再按上限缩——窗口不大时截图像素就等于 CSS 像素，
 * 模型给的坐标原样可用；Retina 的 2 倍像素不进上下文（对看清页面没有帮助，只多花 token）。
 */
export function shotSize(cssWidth: number, cssHeight: number): { width: number; height: number } {
  return fitWithin(cssWidth, cssHeight, SHOT_MAX_WIDTH, SHOT_MAX_HEIGHT);
}

/** 截图上的一点 → 视口 CSS 坐标。出了图的范围回 null（多半是看错了图或页面已经变了） */
export function toCssPoint(shot: ShotGeometry, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > shot.width || y > shot.height) return null;
  return {
    x: Math.min(x * (shot.cssWidth / shot.width), shot.cssWidth - 1),
    y: Math.min(y * (shot.cssHeight / shot.height), shot.cssHeight - 1),
  };
}

/**
 * 截图上的一块区域 → CDP `Page.captureScreenshot` 的 clip（CSS 像素，**相对文档**：
 * 要加上视口当前的滚动偏移 pageX / pageY）与放大倍数。区域先裁进图内；太小（< 8px）拒绝。
 * 放大到长边接近截图上限，最多 4 倍——再大就只是把模糊的像素放大。
 */
export function regionClip(
  shot: ShotGeometry,
  region: { x: number; y: number; width: number; height: number },
  scroll: { pageX: number; pageY: number },
): { x: number; y: number; width: number; height: number; scale: number } | null {
  const left = Math.max(0, region.x);
  const top = Math.max(0, region.y);
  const right = Math.min(shot.width, region.x + region.width);
  const bottom = Math.min(shot.height, region.y + region.height);
  if (!(right - left >= 8 && bottom - top >= 8)) return null;
  const sx = shot.cssWidth / shot.width;
  const sy = shot.cssHeight / shot.height;
  const width = (right - left) * sx;
  const height = (bottom - top) * sy;
  const scale = Math.max(1, Math.min(4, SHOT_MAX_WIDTH / width, SHOT_MAX_HEIGHT / height));
  return { x: scroll.pageX + left * sx, y: scroll.pageY + top * sy, width, height, scale };
}
