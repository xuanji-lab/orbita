/**
 * 专注计时的纯状态机（原型的状态 5–7：开始 / 专注中 / 点开胶囊）。
 *
 * 只算时间，不碰 DOM、不碰 IPC——`node --test` 直接可测；跳动与通知在
 * `use-focus.ts`（hook），界面在 `FocusControl.tsx`。状态不落盘：用户裁决
 * 「关掉应用重开 = 已结束」，内存里的计时器天然满足。
 */

/** 滚轮的时长档（分钟），原型的定档 */
export const FOCUS_MINUTES: readonly number[] = [10, 15, 20, 25, 30, 45, 60, 90, 120];

/** 默认档（分钟）——原型与番茄钟惯例都是 25 */
export const FOCUS_MINUTES_DEFAULT = 25;

/** 滚轮一行的高度（px）：选档判定 = round(scrollTop / 行高)，几何在 FocusControl 同步 */
export const FOCUS_WHEEL_ROW = 32;

/**
 * 剩这么多毫秒时收工小结起跑（家务活模型要分钟量级，预留给它；原型状态 8）。
 * 滚轮最小档 10 分钟，T-5 恒在开始之后——不存在「来不及等」的档位。
 */
export const SUMMARY_LEAD_MS = 5 * 60_000;

/** 一次专注。startedAt/endsAt 是 Date.now() 的毫秒；延长时 totalMs 与 endsAt 同步右移 */
export interface FocusRun {
  workspaceId: string;
  /** 开始时刻（毫秒） */
  startedAt: number;
  /** 总时长（毫秒，含延长） */
  totalMs: number;
  /** 结束时刻（毫秒，含延长） */
  endsAt: number;
}

export function startFocusRun(now: number, workspaceId: string, minutes: number): FocusRun {
  const totalMs = Math.round(minutes * 60_000);
  return { workspaceId, startedAt: now, totalMs, endsAt: now + totalMs };
}

/** 延长（+5 / +15）：结束点右移，总量跟着加——进度线与「共 N 分钟」都读它 */
export function extendFocusRun(run: FocusRun, minutes: number): FocusRun {
  const add = Math.round(minutes * 60_000);
  return { ...run, totalMs: run.totalMs + add, endsAt: run.endsAt + add };
}

/** 剩余毫秒，到 0 为止（不会负） */
export function remainMs(run: FocusRun, now: number): number {
  return Math.max(0, run.endsAt - now);
}

/** 收工小结该起跑了吗：剩 SUMMARY_LEAD_MS 以内（含到点后的补跑） */
export function shouldStartSummary(run: FocusRun, now: number): boolean {
  return remainMs(run, now) <= SUMMARY_LEAD_MS;
}

/** 已过进度（0..1）：胶囊浮层那条细进度线的宽度 */
export function focusProgress(run: FocusRun, now: number): number {
  const total = Math.max(1, run.totalMs);
  return Math.min(1, Math.max(0, (now - run.startedAt) / total));
}

/**
 * 倒计时文案 `mm:ss`（等宽 + tabular-nums，每秒跳一下，不做翻页动画）。
 * 秒向下取整：显示的剩余不会比真实的长。超过 99 分钟分钟位就是三位数
 * （`120:00`），照样可读——不引入小时档（120 分钟是滚轮的最大档）。
 */
export function formatFocusClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** 滚轮滚动位置 → 选中的档下标（夹回有效区间；scroll 值可能是小数或负的橡皮筋） */
export function wheelIndex(scrollTop: number, count: number): number {
  if (count <= 0) return 0;
  const raw = Math.round(scrollTop / FOCUS_WHEEL_ROW);
  return Math.max(0, Math.min(count - 1, raw));
}

/** 「开始于 HH:MM」（胶囊浮层的工作区行用；24 小时制，本地时区） */
export function formatStartClock(startedAt: number): string {
  const date = new Date(startedAt);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 浮层打开时该选中的工作区：显式选择 > 上次的档位 > 默认（当前会话所在）> 第一个。
 * 工作区列表是异步加载的——挂载时空表初始化出的 null 不会自愈（验收实测：只有一个
 * 工作区时「开始专注」禁用，非得手点一下那行），FocusControl 在列表 / 默认值变化时
 * 按这条链回填；选中的那行已被移除时同样走这条链落回有效项。
 */
export function resolvePickerWorkspace(
  current: string | null,
  preset: string | null,
  defaultId: string | null,
  workspaceIds: readonly string[],
): string | null {
  if (current !== null && workspaceIds.includes(current)) return current;
  if (preset !== null && workspaceIds.includes(preset)) return preset;
  if (defaultId !== null && workspaceIds.includes(defaultId)) return defaultId;
  return workspaceIds[0] ?? null;
}
