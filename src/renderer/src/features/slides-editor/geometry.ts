/**
 * 画布交互的几何：缩放手柄、移动吸附（对齐线）、线端点、适应缩放。纯函数，无 DOM，可直接 node --test。
 *
 * 思路参照 PPTist（AGPL-3.0，与本仓同许可）的 ResizeHandler / AlignmentLine：手柄按方向分解成
 * 「动哪几条边」，Shift 等比时以对角为锚；吸附把被拖元素的左 / 中 / 右（上 / 中 / 下）与画布和
 * 其它元素的同类线比，进阈值就吸过去并出一条对齐线。代码是按本仓的数据模型重写的，不是逐行搬运。
 */
import type { LineElement } from "../../../../shared/slides.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 手柄 → 它动哪几条边（-1 动左 / 上，+1 动右 / 下，0 不动） */
const EDGE: Readonly<Record<Handle, readonly [number, number]>> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export const MIN_SIZE = 8;

/**
 * 拖手柄后的新框。dx / dy 是画布坐标下的位移。
 * keepRatio：以起始宽高比等比缩放——角手柄取两个方向里变化更大的那个，边手柄由那一维带动另一维（以中心线为轴）。
 */
export function resizeBox(start: Box, handle: Handle, dx: number, dy: number, keepRatio: boolean, min = MIN_SIZE): Box {
  const [ex, ey] = EDGE[handle];
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (ex < 0) left += dx;
  if (ex > 0) right += dx;
  if (ey < 0) top += dy;
  if (ey > 0) bottom += dy;
  let w = right - left;
  let h = bottom - top;
  if (keepRatio && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    if (ex !== 0 && ey !== 0) {
      // 角：哪个方向相对起始尺寸变化大就听哪个
      const byW = Math.abs(w / start.w - 1) >= Math.abs(h / start.h - 1);
      if (byW) h = w / ratio;
      else w = h * ratio;
    } else if (ex !== 0) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
    w = Math.max(w, min);
    h = Math.max(h, min);
    // 锚点：动哪边，对边不动；边手柄的另一维以中心为轴
    const x = ex < 0 ? start.x + start.w - w : ex > 0 ? start.x : start.x + (start.w - w) / 2;
    const y = ey < 0 ? start.y + start.h - h : ey > 0 ? start.y : start.y + (start.h - h) / 2;
    return { x, y, w, h };
  }
  // 翻过中线：夹到最小尺寸，对边不动
  if (w < min) {
    if (ex < 0) left = right - min;
    else right = left + min;
    w = min;
  }
  if (h < min) {
    if (ey < 0) top = bottom - min;
    else bottom = top + min;
    h = min;
  }
  return { x: left, y: top, w, h };
}

export interface Guides {
  /** 竖直对齐线的 x（画布坐标） */
  vertical: number[];
  /** 水平对齐线的 y */
  horizontal: number[];
}

function candidates(box: Box): { xs: number[]; ys: number[] } {
  return { xs: [box.x, box.x + box.w / 2, box.x + box.w], ys: [box.y, box.y + box.h / 2, box.y + box.h] };
}

/**
 * 移动吸附：被拖的框（已加上位移）与画布、其它元素的左中右 / 上中下线比，距离 ≤ threshold 就吸过去。
 * 返回修正后的框与要画的对齐线。threshold 以**画布坐标**计（调用方用 6 / 缩放比换算，缩小时手感一致）。
 */
export function snapMove(moved: Box, others: readonly Box[], canvas: { w: number; h: number }, threshold: number): { box: Box; guides: Guides } {
  const targets = [{ x: 0, y: 0, w: canvas.w, h: canvas.h }, ...others].map(candidates);
  const mine = candidates(moved);
  let bestX: { delta: number; at: number } | null = null;
  let bestY: { delta: number; at: number } | null = null;
  for (const target of targets) {
    for (const mx of mine.xs) {
      for (const tx of target.xs) {
        const delta = tx - mx;
        if (Math.abs(delta) <= threshold && (bestX === null || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, at: tx };
      }
    }
    for (const my of mine.ys) {
      for (const ty of target.ys) {
        const delta = ty - my;
        if (Math.abs(delta) <= threshold && (bestY === null || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, at: ty };
      }
    }
  }
  const box = { ...moved, x: moved.x + (bestX?.delta ?? 0), y: moved.y + (bestY?.delta ?? 0) };
  return {
    box,
    guides: { vertical: bestX === null ? [] : [bestX.at], horizontal: bestY === null ? [] : [bestY.at] },
  };
}

export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 两个框相交（框选用） */
export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 规范化拖出来的矩形（起终点任意方向） */
export function boxFromPoints(ax: number, ay: number, bx: number, by: number): Box {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** 线元素的两个端点（画布坐标） */
export function lineEnds(line: Pick<LineElement, "x" | "y" | "points">): [[number, number], [number, number]] {
  return [
    [line.x + line.points[0][0], line.y + line.points[0][1]],
    [line.x + line.points[1][0], line.y + line.points[1][1]],
  ];
}

/** 由两个端点（画布坐标）回算线元素的框与相对点（实现在 shared/slides-ops.ts，与 agent 同源） */
export { lineGeometry as lineFromEnds } from "../../../../shared/slides-ops.ts";

/** 终点按 45° 的倍数吸附（Shift 画直线） */
export function constrainAngle(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length];
}

/** 适应：让画布完整放进容器（留 pad 边距），不放大超过 maxScale */
export function fitScale(container: { w: number; h: number }, canvas: { w: number; h: number }, pad = 24, maxScale = 2): number {
  const avail = { w: Math.max(container.w - pad * 2, 40), h: Math.max(container.h - pad * 2, 40) };
  return Math.min(avail.w / canvas.w, avail.h / canvas.h, maxScale);
}
