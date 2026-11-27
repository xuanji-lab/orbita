import { mediaKindOf } from "../../../../shared/files.ts";

/**
 * 音视频播放器的**纯逻辑**（时间格式 / 进度换算 / 倍速 / 键盘）。组件 MediaView.tsx 要连 IPC 与 <audio> /
 * <video> 元素，这里只留纯函数，`node --test` 直接可测（理由同 preview-view.ts）。
 */

/** 倍速档：音频才给（视频靠快捷键 / 别处，面板里不放这一档，避免控制条拥挤） */
export const PLAYBACK_RATES: readonly number[] = [1, 1.25, 1.5, 2];

/** 方向键一次跳的秒数（YouTube / Vimeo / Plyr 默认 5–10 s，取 5） */
export const SEEK_STEP_SECONDS = 5;

/** 时长是否可用：流式 mp3 无头信息时 duration 是 Infinity / NaN，按「未知」处理 */
export function isKnownDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0;
}

/**
 * 秒 → 时钟：`3:51` / `0:07` / `1:02:03`。负数、NaN、Infinity 一律 `0:00`；
 * 小数向下取整（播放到 3.9 s 显示 0:03，与播放器惯例一致，不提前进位）。
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** 当前位置占总长的比例 [0, 1]；时长未知 / 为 0 时 0 */
export function progressFraction(current: number, duration: number): number {
  if (!isKnownDuration(duration) || !Number.isFinite(current)) return 0;
  return Math.min(1, Math.max(0, current / duration));
}

/** 指针 x 落在进度条上的比例 [0, 1]（条宽 0 时 0） */
export function fractionAtPointer(clientX: number, trackLeft: number, trackWidth: number): number {
  if (!(trackWidth > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
}

/** 方向键跳转：夹在 [0, duration]（时长未知时只夹下限） */
export function seekTarget(current: number, delta: number, duration: number): number {
  const next = Math.max(0, (Number.isFinite(current) ? current : 0) + delta);
  return isKnownDuration(duration) ? Math.min(duration, next) : next;
}

/** 倍速循环：1 → 1.25 → 1.5 → 2 → 1；不在表里的值回 1 */
export function nextRate(current: number): number {
  const index = PLAYBACK_RATES.indexOf(current);
  if (index === -1) return PLAYBACK_RATES[0] ?? 1;
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

/** 倍速的显示：`1×` / `1.25×` / `1.5×` / `2×` */
export function formatRate(rate: number): string {
  return `${rate}×`;
}

export type MediaKeyAction = "toggle" | "back" | "forward";

/**
 * 播放器上的键盘：空格 播放 / 暂停，← / → 跳 5 秒。
 * 带修饰键的不吃（Cmd+← 之类归浏览器 / 系统）。焦点在按钮上时空格 / 回车由按钮自己的点击处理，
 * 这里不重复触发（否则一次空格 toggle 两次、等于没动）。
 */
export function mediaKeyAction(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  targetTag: string;
}): MediaKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const onButton = event.targetTag === "BUTTON";
  if (event.key === " " || event.key === "Spacebar") return onButton ? null : "toggle";
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}

/** 扩展名大写作格式标签：`wang.mp3` → `MP3`；没有扩展名回空串 */
export function formatLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toUpperCase();
}

/**
 * 对话里一个链接的 href 若是指向本机音 / 视频文件的绝对路径（`/Users/…/a.mp3`、`C:\\…\\a.mp4`、`file:///…`），
 * 回解码后的路径；否则 null。点击据此在右侧文件面板打开播放，而不是被当作无效链接吞掉。
 * 只认媒体扩展名：别的本地文件链接今天不可点，这里不顺带放开。
 */
export function localMediaPathOfHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  let path = href.trim();
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
    // file:///C:/x/a.mp4 → /C:/x/a.mp4：去掉盘符前多出的斜杠
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:(?!\\|\/)/.test(path)) {
    return null; // https: / mailto: / javascript: 等
  } else {
    try {
      path = decodeURIComponent(path);
    } catch {
      // 不是合法的百分号编码：按原样当路径
    }
  }
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (!absolute) return null;
  return mediaKindOf(path) === null ? null : path;
}
