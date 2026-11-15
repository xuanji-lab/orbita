/**
 * PDF 阅读器面板的纯函数（PdfReaderView.tsx 连 iframe 与 IPC，这里不碰——`node --test` 直接可测）。
 */
import {
  PDF_READER_ORIGIN,
  parseReaderEvent,
  type PdfAnnotationsBlock,
  type ReaderAnnotation,
  type ReaderEvent,
} from "../../../../shared/pdf-reader.ts";
import type { PageRect } from "./pdf-view.ts";

/**
 * 批注栏并排还是浮层的分界（面板宽度，px）。页面低于约 680px 时 pdf.js 的视图开始挤（Hypothesis 的
 * MIN_PDF_WIDTH = 680 就是这条经验），加上 240px 的批注栏 ≈ 920：面板比它窄时批注栏浮在页面上、默认收起，
 * 页面始终适宽；比它宽时并排、默认展开。
 */
export const READER_SIDE_BY_SIDE_MIN = 920;

export function isNarrowReader(width: number): boolean {
  return width < READER_SIDE_BY_SIDE_MIN;
}

/**
 * 收页面的消息：只认我们自己的那个 iframe（source 比对）且来自阅读器的源；形状再逐字段校验。
 * 别的框架（插件面板、别的标签）发来的同形消息不会被当成阅读器的。
 */
export function acceptReaderMessage(
  event: { source: unknown; origin: string; data: unknown },
  frameWindow: unknown,
): ReaderEvent | null {
  if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return null;
  if (event.origin !== PDF_READER_ORIGIN) return null;
  return parseReaderEvent(event.data);
}

/** 阅读器里点的外链：只放网页与邮件，交给主进程的 openLink（网页进内置浏览器） */
export function isOpenableLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

/**
 * 存失败时还没落盘的批注：按 id 记最新的一份，删掉的从里面拿掉——重试时一次补齐，
 * 不会把用户已经删掉的又写回去。
 */
export function pendingAfterSave(
  pending: ReadonlyMap<string, ReaderAnnotation>,
  annotations: readonly ReaderAnnotation[],
): Map<string, ReaderAnnotation> {
  const next = new Map(pending);
  for (const item of annotations) next.set(item.id, { ...(next.get(item.id) ?? {}), ...item });
  return next;
}

export function pendingAfterDelete(pending: ReadonlyMap<string, ReaderAnnotation>, ids: readonly string[]): Map<string, ReaderAnnotation> {
  const next = new Map(pending);
  for (const id of ids) next.delete(id);
  return next;
}

/** 数据文件写不了时的提示文案选择（文案表由调用方传进来） */
export function blockedMessage(
  blocked: PdfAnnotationsBlock,
  file: string,
  t: { readOnly: string; corrupt: (file: string) => string; foreign: (file: string) => string; newer: (file: string) => string },
): string {
  switch (blocked) {
    case "read-only":
      return t.readOnly;
    case "corrupt":
      return t.corrupt(file);
    case "foreign":
      return t.foreign(file);
    case "newer":
      return t.newer(file);
  }
}

/** 页面像素（scale 1、左上角原点）→ PDF 用户空间矩形（左下角原点）。viewBox = 页面的 [x0, y0, x1, y1] */
export function pageRectToPdf(rect: PageRect, viewBox: readonly number[]): number[] {
  const [x0 = 0, , , y1 = 0] = viewBox;
  const left = x0 + rect.left;
  const right = x0 + rect.left + rect.width;
  const top = y1 - rect.top;
  const bottom = y1 - (rect.top + rect.height);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return [round(left), round(bottom), round(right), round(top)];
}
