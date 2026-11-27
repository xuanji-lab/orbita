/**
 * 状态卡里 PDF 缩略图「画好的首页」的跨挂载缓存。
 *
 * 卡按会话重挂；PDF 缩略图每次挂上都要：读整份字节（IPC）→ pdf.js 解析 → 渲染首页，期间是一块空白
 * （实测 4 MB 的 PDF 空白约 75ms，几十 MB 的更久；超过 3 MB 的字节还不进 thumb-cache，每次都重读）。
 * 这里把画好的首页留成位图（ImageBitmap），重挂时同步贴上去，字节读回来对得上（字节数没变）就不再重画。
 *
 * 位图占内存（DPR 2、卡宽 340 左右的首页约 2.5 MB），所以只留最近 8 张；同一份 PDF 一分钟内验过就不再读盘。
 * 纯逻辑（命中 / 新鲜判定）与 DOM 无关，可被 node --test 直接加载。
 */
import { LruCache } from "../../../../shared/lru.ts";

export interface PdfShot {
  bitmap: ImageBitmap;
  /** 校验戳：PDF 字节数（同 thumb-cache 里 PDF 的戳） */
  stamp: number;
  /** 画的时候缩略图框的 CSS 宽、高（px）与设备像素比 */
  cssWidth: number;
  cssHeight: number;
  ratio: number;
  /** 上次确认「盘上的文件还是这一份」的时刻 */
  checkedAt: number;
}

export const PDF_SHOT_LIMIT = 8;
/** 这么久之内验过的，重挂时不再读盘重验 */
export const PDF_SHOT_FRESH_MS = 60_000;

export const pdfShots = new LruCache<PdfShot>(PDF_SHOT_LIMIT);

/** 位图能不能直接贴：框宽（差 2px 以内）与设备像素比都对得上 */
export function shotFits(shot: Pick<PdfShot, "cssWidth" | "ratio">, width: number, ratio: number): boolean {
  return Math.abs(shot.cssWidth - width) < 2 && shot.ratio === ratio;
}

/** 一分钟内验过：重挂时可以不读盘 */
export function shotFresh(shot: Pick<PdfShot, "checkedAt">, now: number): boolean {
  return now - shot.checkedAt < PDF_SHOT_FRESH_MS;
}

/** 读回来的字节与位图对得上（字节数没变）：位图继续用，不重画 */
export function shotMatches(shot: Pick<PdfShot, "stamp">, data: { byteLength: number }): boolean {
  return shot.stamp === data.byteLength;
}
