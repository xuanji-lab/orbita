/**
 * 对话里看板「画好的样子」的跨挂载缓存。
 *
 * 看板按会话重挂；iframe 换一次性地址、加载、再收数据的期间，旧实现只留一块同高空白。
 * 这里把宿主窗口截到的 PNG 留成 ImageBitmap，重挂时同步贴上，等真 iframe 画好再换下。
 * 快照数据本身不可变，但主题、宽度、DPR 都会改变像素；对不上就不用。位图只用于刚切回的一小段，
 * 超过一分钟直接等真 iframe，不让旧图长期盖住模板自己的动态内容。
 */
import { LruCache } from "../../../../shared/lru.ts";

export interface BoardShot {
  bitmap: ImageBitmap;
  /** 截图时看板外框的 CSS 宽、高与设备像素比 */
  cssWidth: number;
  cssHeight: number;
  ratio: number;
  /** 截图时的应用主题（明 / 玄等主题的卡面像素不同，不能混贴） */
  theme: string;
  capturedAt: number;
}

export const BOARD_SHOT_LIMIT = 8;
export const BOARD_SHOT_FRESH_MS = 60_000;

export const boardShots = new LruCache<BoardShot>(BOARD_SHOT_LIMIT);

/** 会话与工具调用一起作键：不同会话即使 toolCallId 撞了也绝不互贴。 */
export function boardShotKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

/** 位图能不能直接贴：布局、像素比、主题一致，且仍是刚切回时该用的近期图。 */
export function boardShotFits(
  shot: Pick<BoardShot, "cssWidth" | "cssHeight" | "ratio" | "theme" | "capturedAt">,
  current: { width: number; height: number; ratio: number; theme: string; now: number },
): boolean {
  return (
    Math.abs(shot.cssWidth - current.width) < 2 &&
    Math.abs(shot.cssHeight - current.height) < 2 &&
    shot.ratio === current.ratio &&
    shot.theme === current.theme &&
    current.now - shot.capturedAt >= 0 &&
    current.now - shot.capturedAt < BOARD_SHOT_FRESH_MS
  );
}
