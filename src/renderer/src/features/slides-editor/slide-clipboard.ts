import { newId, type SlideElement } from "../../../../shared/slides.ts";

/**
 * 画布里复制 / 剪切的元素（模块级一格）：⌘C / ⌘X 存进来，⌘V 取出——每次粘贴换新 id，
 * 并依次错开 20px（连续粘贴不叠在同一处）。放在内存而不是系统剪贴板：系统剪贴板留给图片与文字
 * （粘贴截图要走它），两边不抢。
 */
let stored: readonly SlideElement[] = [];
let pasteCount = 0;

export function copyElements(elements: readonly SlideElement[]): void {
  stored = elements.map((element) => structuredClone(element));
  pasteCount = 0;
}

export function hasCopiedElements(): boolean {
  return stored.length > 0;
}

export function pasteElements(): SlideElement[] {
  pasteCount += 1;
  const offset = 20 * pasteCount;
  return stored.map((element) => ({ ...structuredClone(element), id: newId(), x: element.x + offset, y: element.y + offset }));
}
