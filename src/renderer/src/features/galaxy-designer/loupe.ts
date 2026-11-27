import { PREVIEW_FRAME, type Circle } from "./design.ts";
import { ORBIT_VIEW, type WellBox } from "./well.ts";

/**
 * 行星页预览的「局部放大」版式（2026-11-24 用户手绘草图）：一张卡里，引力场（网格 + 主星 + 轨道上的这颗行星）
 * 和这颗行星的大形象并排；两根虚线引线从场景里那颗小行星连到大形象（两球的外公切线）——技术图纸里的局部放大画法，
 * 说明右边（下边）的大图就是左边（上边）那颗小点。
 *
 * 宽时左右排，窄时上下排；坐标一律是画框里的 CSS 像素（viewBox = 0 0 w h），线宽与字号不随缩放走样。
 * 这里只有纯几何：取哪种排法、两块各占哪里、大形象放多大、两根公切线在哪。组件只画。
 */

export type LoupeLayout = "side" | "stack";

/**
 * 画框宽（面板内容宽）≥ 这个值左右排，否则上下排。
 * 面板宽 260（地板）–（窗口里 chat + 右栏的 2/3），默认 320；.gd 两侧各留 --space-4（16px），画框宽 = 面板宽 − 32，
 * 即 228 到七八百。280 对应面板 312：默认的 320 刚好左右排；拖到地板附近（260–311）才叠起来。
 * 再窄，左半的轨道场景只剩 150px 宽，主星最小 10px、行星最小 5px 的身影挤在一起认不出来，所以叠。
 */
export const LOUPE_SIDE_MIN = 280;

/** 左右排时左半（引力场）占的比例：场景要装下最远的轨道，比形象需要的地方多 */
export const SIDE_SPLIT = 0.56;

/** 左右排与主星页同一个高宽比（260 : 180）：在主星 / 行星两页之间切，预览高度不跳 */
export const SIDE_ASPECT = 180 / 260;

/**
 * 左右排的高度上限（CSS px）：面板拉到五六百宽时不再按比例长高（否则撞上 CSS 的 28vh 上限，整幅缩小、两侧留空），
 * 多出来的宽度给引力场（网格铺得更开）。240 ≈ 900 高的窗口里 28vh 的 252 往下取整一点。
 */
export const SIDE_MAX_H = 240;

/** 上下排：上面场景 260 : 140（原来轨道小场景的比例）、下面形象 260 : 150 */
export const STACK_SCENE_ASPECT = 140 / 260;
export const STACK_DETAIL_ASPECT = 150 / 260;

/** 引力场那一块的取景：左右排时场景块偏方，轨道按宽装、原点放低一点给坑留地方；上下排沿用原来轨道小场景的取景 */
export const LOUPE_VIEW: Readonly<Record<LoupeLayout, { fitW: number; fitH: number; originY: number }>> = {
  side: { fitW: 0.9, fitH: 0.62, originY: 0.44 },
  stack: { fitW: ORBIT_VIEW.fitW, fitH: ORBIT_VIEW.fitH, originY: ORBIT_VIEW.originY },
};

/**
 * 引线切的是球本身（半径 art.r）再往外留几像素，不是连星环 / 卫星在内的外框：开了星环的行星外框是一个扁长条，
 * 拿它的外接圆当切圆，引线会落在球上下很远的空白里，看不出指着谁（2026-11-24 实测，宽面板 + 星环 + 卫星）。
 * 星环从引线上穿过去是对的——图纸上的引线本来就压在零件上。
 */
/** 小行星（球）外再留几像素才起线，线不贴着天体 */
export const MARK_GAP = 3;
/** 大形象（球）外留的空 */
export const DETAIL_GAP = 4;

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LoupeFrame {
  layout: LoupeLayout;
  w: number;
  h: number;
  /** 引力场那一块 */
  scene: WellBox;
  /** 大形象那一块 */
  detail: WellBox;
  /** 两块之间的发丝分隔线 */
  divider: Segment;
}

export function loupeLayout(width: number): LoupeLayout {
  return width >= LOUPE_SIDE_MIN ? "side" : "stack";
}

/** 量不到宽度（还没挂上）时按默认面板 320 的内容宽算，首帧不闪 */
export const LOUPE_DEFAULT_WIDTH = 288;

export function loupeFrame(width: number): LoupeFrame {
  const w = Math.round(Number.isFinite(width) && width > 0 ? width : LOUPE_DEFAULT_WIDTH);
  if (loupeLayout(w) === "side") {
    const h = Math.min(Math.round(w * SIDE_ASPECT), SIDE_MAX_H);
    // 形象那一块不必比画框高更宽：宽面板上把多出来的宽度给引力场
    const split = Math.max(Math.round(w * SIDE_SPLIT), w - Math.round(h * 0.95));
    return {
      layout: "side",
      w,
      h,
      scene: { x: 0, y: 0, w: split, h },
      detail: { x: split, y: 0, w: w - split, h },
      // 分隔线不顶天立地：上下各让 14%，像图纸上两幅视图之间的一道界，不是把卡切成两张
      divider: { x1: split, y1: Math.round(h * 0.14), x2: split, y2: Math.round(h * 0.86) },
    };
  }
  const sceneH = Math.round(w * STACK_SCENE_ASPECT);
  const detailH = Math.round(w * STACK_DETAIL_ASPECT);
  return {
    layout: "stack",
    w,
    h: sceneH + detailH,
    scene: { x: 0, y: 0, w, h: sceneH },
    detail: { x: 0, y: sceneH, w, h: detailH },
    divider: { x1: Math.round(w * 0.14), y1: sceneH, x2: Math.round(w * 0.86), y2: sceneH },
  };
}

/**
 * 大形象的缩放（displayRadius 的 px → 画框 px）：按「标称画框」PREVIEW_FRAME 的高装进形象那一块；
 * 形象连星环 / 卫星装不下这一块时（各边留 8%）再缩到刚好装下。标称缩放是固定的、不按这颗行星自己的大小取，
 * 所以质量变了大形象跟着变大变小（与原来的大头像同一个规矩）；只有大到装不下时才贴边。
 * zoom（预览缩放，百分比）乘在标称缩放上，但同样不超出这一块：大形象被画框裁掉一截，引线就指向了画框外面。
 */
export function detailScale(detail: WellBox, extent: { x: number; y: number }, zoom = 100): number {
  const nominal = (Math.min(detail.w, detail.h) / (PREVIEW_FRAME.halfH * 2)) * (zoom / 100);
  const fitX = extent.x > 0 ? detail.w / (2 * 1.08 * extent.x) : Infinity;
  const fitY = extent.y > 0 ? detail.h / (2 * 1.08 * extent.y) : Infinity;
  return Math.min(nominal, fitX, fitY);
}

/**
 * 两个圆的两条外公切线（小圆 a → 大圆 b）。两圆相交或相含时没有外公切线，返回 null（不画引线）。
 * 外公切线的切点：p = c + r·n，n 是把 a→b 的单位向量转 ±φ，cos φ = (ra − rb) / d。
 * 返回顺序固定：先「左手边」那条（左右排时是上面那根，上下排时是右边那根），再另一条。
 */
export function externalTangents(a: Circle, b: Circle): [Segment, Segment] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (!(d > 0) || d <= a.r + b.r) return null;
  const ux = dx / d;
  const uy = dy / d;
  const cos = (a.r - b.r) / d;
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const line = (sign: number): Segment => {
    // 把 u 转 sign·φ（屏幕坐标 y 向下：sign = −1 是往上转）
    const nx = ux * cos - sign * uy * sin;
    const ny = sign * ux * sin + uy * cos;
    return { x1: a.x + a.r * nx, y1: a.y + a.r * ny, x2: b.x + b.r * nx, y2: b.y + b.r * ny };
  };
  return [line(-1), line(1)];
}
