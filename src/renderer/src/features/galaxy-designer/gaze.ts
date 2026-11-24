/**
 * 眼睛的注意力（纯计算，可被 node --test 直接加载；DOM 那一半在 gaze-runtime.ts）。
 *
 * 2026-11-24 用户：「如果眼睛能跟着鼠标就好了……设置一个呼吸感，就是不同的行星，注意力是随机的，偶尔注视鼠标的位置，偶尔就分心了。」
 * 每颗天体（主星、行星、侧栏头像）各有一台小状态机：
 * - look：注视指针，眼睛转向指针方向，持续 GAZE_TIMES.look（1.5–4 秒）；
 * - away：分心，持续 GAZE_TIMES.away（2–6 秒）。分心里一半是看向别处（随机方向、随机远近），一半是发呆（眼睛回到正中、
 *   略往下一点）；分心时有一半概率在中途慢慢眨一次眼。
 * 第一段一律从分心开始、时长随机（0–6 秒），各天体就错开了，不会一起转过来。指针离开窗口：一律分心。
 * 随机数由调用方给（测试用播种的 mulberry32），这里不碰 Math.random。
 */

export type GazeMode = "look" | "away";

export interface GazeState {
  mode: GazeMode;
  /** 这一段到什么时候（ms，与 now 同一个钟） */
  until: number;
  /** away 时看哪儿：单位圆里的一点（0 = 正中）；look 时不用 */
  aim: { x: number; y: number };
  /** 这一段里什么时候眨一次眼（ms）；null = 不眨 */
  blinkAt: number | null;
}

export type Rng = () => number;

/** 各段时长（ms） */
export const GAZE_TIMES = {
  look: { min: 1500, max: 4000 },
  away: { min: 2000, max: 6000 },
  /** 第一段（分心）的时长上限：从 0 起随机，各天体错开 */
  firstAwayMax: 6000,
} as const;

/** 分心结束后回去注视指针的概率（否则再分心一段，换个地方看） */
export const LOOK_CHANCE = 0.6;
/** 一段分心里眨一次眼的概率 */
export const BLINK_CHANCE = 0.5;
/** 眨眼多长（ms），慢慢眨 */
export const BLINK_MS = 260;

/** 播种的随机数（mulberry32）：测试与可复现的场合用 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

function awayState(rng: Rng, now: number, duration: number): GazeState {
  // 一半是看向别处（随机方向、0.5–1 的远近），一半是发呆（回到正中、略往下）
  let aim: { x: number; y: number };
  if (rng() < 0.5) {
    const a = rng() * Math.PI * 2;
    const d = between(rng, 0.5, 1);
    aim = { x: Math.cos(a) * d, y: Math.sin(a) * d };
  } else {
    aim = { x: 0, y: 0.25 };
  }
  const blinkAt = rng() < BLINK_CHANCE ? now + between(rng, 0.2, 0.8) * duration : null;
  return { mode: "away", until: now + duration, aim, blinkAt };
}

/** 刚挂上的天体：从分心开始，第一段 0–6 秒随机（错开） */
export function firstGaze(rng: Rng, now: number): GazeState {
  return awayState(rng, now, rng() * GAZE_TIMES.firstAwayMax);
}

/** 这一段到点了：换下一段。指针不在窗口里时一律分心 */
export function nextGaze(prev: GazeState, rng: Rng, now: number, pointerInside: boolean): GazeState {
  const look = pointerInside && (prev.mode === "away" ? rng() < LOOK_CHANCE : false);
  if (look) return { mode: "look", until: now + between(rng, GAZE_TIMES.look.min, GAZE_TIMES.look.max), aim: { x: 0, y: 0 }, blinkAt: null };
  return awayState(rng, now, between(rng, GAZE_TIMES.away.min, GAZE_TIMES.away.max));
}

/**
 * 眼睛此刻该挪到哪（单位：最大位移的倍数，长度 ≤ 1，屏幕平面里）：
 * look = 朝指针的方向，离得近时挪得少（指针就在脸上时几乎正视）；away = aim。
 */
export function gazeOffset(state: GazeState, center: { x: number; y: number }, pointer: { x: number; y: number } | null): { x: number; y: number } {
  if (state.mode === "away" || pointer === null) return state.aim;
  const dx = pointer.x - center.x;
  const dy = pointer.y - center.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const k = Math.min(1, d / GAZE_REACH_PX);
  return { x: (dx / d) * k, y: (dy / d) * k };
}

/** 指针离天体这么远（px）以上，眼睛转到底 */
export const GAZE_REACH_PX = 160;
