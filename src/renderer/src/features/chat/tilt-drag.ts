// 值 import 走相对路径：node --test 解析不了 @shared 别名
import { GALAXY_AZIMUTH_DEFAULT, GALAXY_TILT } from "../../../../shared/settings.ts";

/**
 * 星系空白处拖动 = Blender / Rhino 视口的「转台」（turntable）：锁 z 轴，无极、跟手
 * （2026-11-24 用户：「我想象的就是 blender or rhino 里那种 3d 视图的拖动，只不过是锁 z 轴的视角，无极调节的感觉。」）。
 * 这里是手势的纯规则，HomeGalaxy 的 useTurntable 把指针事件喂进来、每帧重新投影（turntable.ts）。
 *
 * - 位移不超过 thresholdPx 算点击：点主星 / 行星 / 碎石照旧打开，不被拖动吃掉；超过才算拖，松手后吞掉那一下 click。
 * - 上下拖改俯角（绕水平轴）：往下拖 = 俯角变大（更像从上往下看），与 Blender 视口同向；左右拖绕竖直的 z 轴转方位角：
 *   往右拖 = 星系逆时针（从上往下看）转、近处的东西往右走——像用手拨转台。不翻滚。
 * - 灵敏度参照 Blender（约 0.3°/px），两个方向同一个；拖动中不分档，松手才按 1° 存（与设置页滑块同一个精度）。
 * - 俯角夹在 10°–60°；方位角取模 360。
 */
export const TILT_DRAG = {
  /** 超过这么多像素（直线距离）才算拖 */
  thresholdPx: 4,
  /** 每像素改多少度（俯角与方位角同一个） */
  degPerPx: 0.3,
  /** 键盘每按一次改几度 */
  keyStep: 5,
} as const;

/** 默认视角：双击空白处回到这里（Blender 的视口复位习惯：一键回到起始视角） */
export const VIEW_DEFAULT: Readonly<ViewAngles> = { tilt: GALAXY_TILT.default, azimuth: GALAXY_AZIMUTH_DEFAULT };

export interface ViewAngles {
  /** 俯角（度） */
  tilt: number;
  /** 方位角（度，[0, 360)） */
  azimuth: number;
}

/** 这次按下之后的位移算不算拖动（≤ 阈值是点击） */
export function isDragMove(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > TILT_DRAG.thresholdPx;
}

/** 俯角夹进 10°–60°（连续，不取整） */
export function clampTilt(deg: number): number {
  if (!Number.isFinite(deg)) return GALAXY_TILT.default;
  return Math.min(GALAXY_TILT.max, Math.max(GALAXY_TILT.min, deg));
}

/** 方位角取模到 [0, 360) */
export function wrapAzimuth(deg: number): number {
  if (!Number.isFinite(deg)) return GALAXY_AZIMUTH_DEFAULT;
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** 从 start 开始、指针移了 (dx, dy) 像素（往右、往下为正）之后的视角。turntable 关着时左右拖不改方位角 */
export function dragAngles(start: ViewAngles, dx: number, dy: number, turntable: boolean): ViewAngles {
  return {
    tilt: clampTilt(start.tilt + dy * TILT_DRAG.degPerPx),
    azimuth: turntable ? wrapAzimuth(start.azimuth + dx * TILT_DRAG.degPerPx) : start.azimuth,
  };
}

/** 存盘：按 1° 取整（俯角夹在区间里，方位角 360 回到 0） */
export function anglesForSave(view: ViewAngles): ViewAngles {
  return { tilt: Math.round(clampTilt(view.tilt)), azimuth: Math.round(wrapAzimuth(view.azimuth)) % 360 };
}

/**
 * 星系获得焦点时按键改视角：↓ 俯角 +5°、↑ −5°（与拖动同向）；→ 方位 +5°、← −5°（转台关着时左右键不管）。
 * 别的键返回 null（不处理，不拦）
 */
export function keyAngles(current: ViewAngles, key: string, turntable: boolean): ViewAngles | null {
  const step = TILT_DRAG.keyStep;
  if (key === "ArrowDown") return { ...current, tilt: clampTilt(current.tilt + step) };
  if (key === "ArrowUp") return { ...current, tilt: clampTilt(current.tilt - step) };
  if (!turntable) return null;
  if (key === "ArrowRight") return { ...current, azimuth: wrapAzimuth(current.azimuth + step) };
  if (key === "ArrowLeft") return { ...current, azimuth: wrapAzimuth(current.azimuth - step) };
  return null;
}

/** 角落的提示：「40° · 120° · 1.4×」（俯角 · 方位角，整数度 · 缩放，一位小数） */
export function anglesLabel(view: ViewAngles, zoom = 1): string {
  const saved = anglesForSave(view);
  return `${saved.tilt}° · ${saved.azimuth}° · ${Number(zoom.toFixed(1))}×`;
}

/**
 * 角度提示旁那一句：屏幕安全布局把这块画布抬得比设置高时（子智能体在设置的俯角下装不下），返回实际画的度数；没抬返回 null。
 * 半度以内当没抬（布局按 1° 细找，抬的值是整数）。
 */
export function raisedTo(setting: number, actual: number | null): number | null {
  if (actual === null || !Number.isFinite(actual) || actual <= setting + 0.5) return null;
  return Math.round(actual);
}
