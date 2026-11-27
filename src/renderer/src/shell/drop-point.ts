/**
 * 拖进输入框时的落点：指针坐标 → 正文里的字符下标（拖图 / 拖任务松手的位置就是小签插入的位置，
 * 2026-11-23 用户：「拖拽到哪，就能嵌入哪」）。
 *
 * 在常驻镜像层（.composer-mirror）上量，与 caret-point.ts 同一个理由：镜像与 textarea 逐字一致、
 * 逐像素同排版，textarea 自己给不出「坐标 → 下标」。做法：
 * 1. 指针落在某颗胶囊的格子里：按横向中线判头 / 尾（胶囊是整块，不让落点进到它中间）；
 * 2. 否则 `document.caretRangeFromPoint`——镜像层平时 pointer-events: none、上面还盖着 textarea，
 *    命中测试到不了它，所以量的这一瞬间临时把镜像打开、textarea 关掉，量完立刻还原（同步，不会被用户看到）。
 *    下标 = 镜像开头到命中点之间的文字长度（Range.toString，胶囊的脸不贡献文字，所以与 textarea 的下标一致）；
 * 3. 最后过 snapSelection 兜底：任何落在胶囊中间的下标吸到最近的一边（与点击落光标同一口径）。
 */

import { snapSelection, type ChipRange } from "./composer-chips.ts";

/** 横向中线判头 / 尾：指针在胶囊左半 → 头，右半 → 尾 */
export function chipDropEdge(left: number, right: number, x: number): "start" | "end" {
  return x < (left + right) / 2 ? "start" : "end";
}

/** 下标夹进 [0, length]（镜像末尾有个零宽哨兵，量出来可能多 1） */
export function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

/** 落点吸附：落在胶囊中间的下标吸到最近的一边 */
export function snapDropIndex(chips: readonly ChipRange[], index: number): number {
  return snapSelection(chips, { start: index, end: index }, null).start;
}

/** 镜像开头到（node, offset）之间的文字长度 */
function textBefore(mirror: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(mirror);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * 指针（视口坐标）→ 正文下标。指针在 textarea 的框外、或量不出来时返回 null——调用方按「落末尾」处理。
 */
export function dropIndexAtPoint(
  textarea: HTMLTextAreaElement,
  x: number,
  y: number,
  chips: readonly ChipRange[],
): number | null {
  const box = textarea.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  const mirror = textarea.parentElement?.querySelector(":scope > .composer-mirror") ?? null;
  if (mirror === null) return null;
  const length = textarea.value.length;
  for (const el of Array.from(mirror.querySelectorAll<HTMLElement>(".composer-chip"))) {
    for (const rect of Array.from(el.getClientRects())) {
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const start = textBefore(mirror, el, 0);
      const edge = chipDropEdge(rect.left, rect.right, x);
      return clampIndex(edge === "start" ? start : start + (el.textContent?.length ?? 0), length);
    }
  }
  const mirrorEl = mirror as HTMLElement;
  const before = { mirror: mirrorEl.style.pointerEvents, area: textarea.style.pointerEvents };
  mirrorEl.style.pointerEvents = "auto";
  textarea.style.pointerEvents = "none";
  let range: Range | null = null;
  try {
    range = document.caretRangeFromPoint(x, y);
  } finally {
    mirrorEl.style.pointerEvents = before.mirror;
    textarea.style.pointerEvents = before.area;
  }
  if (range === null || !mirror.contains(range.startContainer)) return null;
  const raw = clampIndex(textBefore(mirror, range.startContainer, range.startOffset), length);
  return snapDropIndex(chips, raw);
}
