/**
 * textarea 里某个位置的**插入点坐标**（在常驻镜像层上量）。
 *
 * 调用方要「按字符下标量出它在 textarea 内容盒里的坐标」（展开粘贴段的收起标签等）。
 * 原生 API 给不了字符坐标，Range 也进不去 textarea——标准做法是垫一个同样排版的镜像
 * div 量字符位置。这里直接用 Composer 的**常驻镜像层**（.composer-mirror，chip /
 * 修正液画的那一层，2026-10-06 起全主题常驻）：同字体、同字距、同宽（滚动条占宽
 * 有补偿），排版逐像素一致，不必每次另建一个量完即弃的临时 div——两层镜像各量
 * 各的迟早量出两套坐标（用户裁决：合并成一层）。
 *
 * 镜像随 textarea 同步滚动（Composer 的 syncMirror / onScroll），Range 量出来的
 * 就是**视觉位置**：textarea 内部滚了多少，坐标自动跟着走，调用方不用再补
 * scrollTop。返回坐标相对 textarea 的 border box。
 */

/** 插入点的位置与该行的行高（都相对 textarea 的 border box、视觉坐标） */
export interface CaretPoint {
  left: number;
  top: number;
  height: number;
}

/**
 * 在镜像层里定位全局文本偏移：镜像的子节点是裸文本、chip / 修正液 span 与末尾的
 * 零宽哨兵（textarea 末尾换行多出的行靠它垫出来），偏移按 textContent 累加换算。
 */
function locateText(root: Node, offset: number): { node: Text; offset: number } | null {
  let remaining = offset;
  for (const child of Array.from(root.childNodes)) {
    const length = child.textContent?.length ?? 0;
    if (child.nodeType === Node.TEXT_NODE) {
      // 裸文本：offset 允许落在末尾（含哨兵的 0 位——文本以 \n 结尾时的下一行）
      if (remaining <= length) return { node: child as Text, offset: remaining };
    } else if (remaining < length) {
      // span（chip / 修正液）：只在其内部才递归；正好在边界上留给下一个兄弟
      return locateText(child, remaining);
    }
    remaining -= length;
  }
  return null;
}

export function caretPoint(textarea: HTMLTextAreaElement, index: number): CaretPoint | null {
  const value = textarea.value;
  if (index < 0 || index > value.length) return null;
  // 镜像与 textarea 同在 .composer-field 的一格里（styles.css 的 grid 叠放）
  const mirror = textarea.parentElement?.querySelector(":scope > .composer-mirror") ?? null;
  if (mirror === null) return null;
  const located = locateText(mirror, index);
  if (located === null) return null;
  const range = document.createRange();
  range.setStart(located.node, located.offset);
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) return null;
  const areaRect = textarea.getBoundingClientRect();
  const computed = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computed.lineHeight);
  return {
    left: rect.left - areaRect.left,
    top: rect.top - areaRect.top,
    height: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : rect.height,
  };
}
