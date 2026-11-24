// 值 import 走相对路径：node --test 解析不了 @shared 别名
import { GALAXY_TILT } from "../../../../shared/settings.ts";

/**
 * 在星系空白处按住左键上下拖动改俯角（2026-11-24 用户：「希望加一个转轴……在空白处按住鼠标左键改变角度。先试试只改变上下，
 * 然后改变之后，要能记住」）。这里是手势的纯规则，HomeGalaxy 的 useTiltDrag 只把指针事件喂进来。
 *
 * - 位移不超过 thresholdPx 算点击：点主星 / 行星 / 碎石照旧打开，不被拖动吃掉；超过才算拖，松手后吞掉那一下 click。
 * - 方向按「抓住盘面往下拉」：往下拖 = 盘面朝你翻 = 俯角变大（更像从上往下看）；往上拖 = 更平。键盘同向：↓ +5°、↑ −5°。
 * - 值落在设置的网格上（GALAXY_TILT：10°–60°、步长 5°），与设置 › 外观里的滑块同一个值、同一个存法。
 */
export const TILT_DRAG = {
  /** 超过这么多像素（直线距离）才算拖 */
  thresholdPx: 4,
  /** 每像素改多少度：往下拖 20px 改一档（5°） */
  degPerPx: 0.25,
  /** 键盘每按一次改几度 */
  keyStep: GALAXY_TILT.step,
} as const;

/** 这次按下之后的位移算不算拖动（≤ 阈值是点击） */
export function isDragMove(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > TILT_DRAG.thresholdPx;
}

/** 任意角度 → 设置网格上的值：夹进 10°–60°，按 5° 取最近的一档 */
export function snapTilt(deg: number): number {
  if (!Number.isFinite(deg)) return GALAXY_TILT.default;
  const steps = Math.round((deg - GALAXY_TILT.min) / GALAXY_TILT.step);
  return Math.min(GALAXY_TILT.max, Math.max(GALAXY_TILT.min, GALAXY_TILT.min + steps * GALAXY_TILT.step));
}

/** 从 start 度开始、指针纵向移了 dy 像素（往下为正）之后的俯角 */
export function dragTilt(start: number, dy: number): number {
  return snapTilt(start + dy * TILT_DRAG.degPerPx);
}

/** 星系获得焦点时按键改俯角：↓ 变大、↑ 变小（与拖动同向）；别的键返回 null（不处理，不拦） */
export function keyTilt(current: number, key: string): number | null {
  if (key === "ArrowDown") return snapTilt(current + TILT_DRAG.keyStep);
  if (key === "ArrowUp") return snapTilt(current - TILT_DRAG.keyStep);
  return null;
}

/**
 * 角度提示旁那一句：屏幕安全布局把这块画布抬得比设置值高时（子智能体在设置的俯角下装不下），返回实际画的度数；没抬返回 null。
 * 半度以内当没抬（布局按 1° 细找，抬的值是整数）。
 */
export function raisedTo(setting: number, actual: number | null): number | null {
  if (actual === null || !Number.isFinite(actual) || actual <= setting + 0.5) return null;
  return Math.round(actual);
}
