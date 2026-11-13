/**
 * 演示文稿的三向合并（结构级）：用户在编辑器里改着，agent 同时写同一份文件时，
 * 把「盘上的新版本」并进「编辑器里的版本」，两边的改动都留下。
 *
 * 文本级的 merge3（文档用）对 JSON 不合适——一页改了几个元素会冲成一团。这里按身份合并：
 * - 页按 id 对齐；元素按 id 对齐；
 * - 一边没动（与 base 相同）就取另一边；两边都动了：页级字段（背景 / 备注）与元素**本地优先**
 *   （用户正在手上改的，别被 agent 的写盖掉；agent 的改动在别的页 / 别的元素上则照常并入）；
 * - 页序：本地调过序就用本地的，否则用盘上的；两边新增的页都保留；
 * - 一边删了、另一边没动 = 删；一边删了、另一边改了 = 保留改的那份。
 * 返回新 Deck；调用方 serialize 后当作合并后的全文。
 */
import { parseDeck, type Deck, type Slide, type SlideElement } from "../../../../shared/slides.ts";

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

function mergeById<T extends { id: string }>(
  base: readonly T[],
  local: readonly T[],
  disk: readonly T[],
  mergeOne: (b: T, l: T, d: T) => T,
): T[] {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const diskMap = new Map(disk.map((item) => [item.id, item]));
  const baseOrder = base.map((item) => item.id);
  const localOrder = local.map((item) => item.id).filter((id) => baseMap.has(id));
  const reordered = !same(
    localOrder,
    baseOrder.filter((id) => localMap.has(id)),
  );
  // 顺序基准：本地调过序用本地，否则用盘上
  const spine = reordered ? local : disk;
  const out: T[] = [];
  const done = new Set<string>();
  const take = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const d = diskMap.get(id);
    if (b === undefined) {
      // 新增：谁有取谁；两边都新增同 id（几乎不会）取本地
      const added = l ?? d;
      if (added !== undefined) out.push(added);
      return;
    }
    if (l === undefined && d === undefined) return; // 两边都删了
    if (l === undefined) {
      // 本地删了：盘上没动 = 删；盘上改了 = 保留盘上的改动
      if (d !== undefined && !same(d, b)) out.push(d);
      return;
    }
    if (d === undefined) {
      if (!same(l, b)) out.push(l); // 盘上删了、本地改了：保留本地
      return;
    }
    if (same(l, b)) out.push(d);
    else if (same(d, b)) out.push(l);
    else out.push(mergeOne(b, l, d));
  };
  for (const item of spine) take(item.id);
  // 另一边独有的（新增 / 仍存活的）补在后面
  for (const item of reordered ? disk : local) take(item.id);
  return out;
}

function mergeElement(_b: SlideElement, l: SlideElement, _d: SlideElement): SlideElement {
  return l; // 同一个元素两边都改了：本地优先
}

function mergeSlide(b: Slide, l: Slide, d: Slide): Slide {
  const pick = <K extends "background" | "notes">(key: K): Slide[K] => (same(l[key], b[key]) ? d[key] : l[key]);
  const background = pick("background");
  const notes = pick("notes");
  return {
    id: l.id,
    ...(background === undefined ? {} : { background }),
    elements: mergeById(b.elements, l.elements, d.elements, mergeElement),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function mergeDecks(base: Deck, local: Deck, disk: Deck): Deck {
  if (same(local, base)) return disk;
  if (same(disk, base)) return local;
  const pick = <K extends "title" | "aspect" | "theme">(key: K): Deck[K] => (same(local[key], base[key]) ? disk[key] : local[key]);
  const theme = pick("theme");
  return {
    version: local.version,
    title: pick("title"),
    aspect: pick("aspect"),
    ...(theme === undefined ? {} : { theme }),
    slides: mergeById(base.slides, local.slides, disk.slides, mergeSlide),
  };
}

/**
 * 文本版：三份 JSON 文本 → 合并后的 Deck。盘上那份读不出来（被写坏 / 写了一半）就**不并**，
 * 保持本地原样——不能让一份坏文件把用户眼前的文稿清空；本地读不出来（不会发生）才退盘上。
 */
export function mergeDeckTexts(base: string, local: string, disk: string): Deck {
  const parse = (text: string): Deck | null => {
    try {
      return parseDeck(text).deck;
    } catch {
      return null;
    }
  };
  const l = parse(local);
  const d = parse(disk);
  if (d === null) return l ?? { version: 1, title: "", aspect: "16:9", slides: [] };
  if (l === null) return d;
  return mergeDecks(parse(base) ?? l, l, d);
}

/**
 * 结构共享：外部（agent）写进来的新 Deck 是整份重新解析的，每一页每个元素都是新对象。
 * 把与旧 Deck **内容相同**的页 / 元素换回旧对象——缩略图与画布按引用 memo，没被改的页不重画；
 * 「哪几页被改了」（缩略图标绿边）也靠引用比，不会五页全亮。
 */
export function shareStructure(prev: Deck, next: Deck): Deck {
  const prevSlides = new Map(prev.slides.map((slide) => [slide.id, slide]));
  const slides = next.slides.map((slide) => {
    const old = prevSlides.get(slide.id);
    if (old === undefined) return slide;
    if (same(old, slide)) return old;
    const prevElements = new Map(old.elements.map((element) => [element.id, element]));
    const elements = slide.elements.map((element) => {
      const was = prevElements.get(element.id);
      return was !== undefined && same(was, element) ? was : element;
    });
    return { ...slide, elements };
  });
  const same_ = slides.length === prev.slides.length && slides.every((slide, i) => slide === prev.slides[i]);
  return same_ && same({ ...prev, slides: [] }, { ...next, slides: [] }) ? prev : { ...next, slides };
}
