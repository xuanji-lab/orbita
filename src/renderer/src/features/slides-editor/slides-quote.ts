import { clampQuote, type TextQuote } from "../../../../shared/quote.ts";
import { slideTitle } from "../../../../shared/slides-ops.ts";
import { richTextToPlain, type Deck, type SlideElement } from "../../../../shared/slides.ts";

/** 一个元素的文字预览（给模型看「这一页上有什么」；真结构让它 slides_read） */
function elementPreview(element: SlideElement): string {
  switch (element.kind) {
    case "text":
      return richTextToPlain(element.html);
    case "image":
      return `[图片 ${element.src.split("/").pop() ?? ""}]`;
    case "table":
      return `[表格 ${element.rows.length}×${element.rows[0]?.length ?? 0}] ${element.rows[0]?.join(" | ") ?? ""}`;
    case "shape":
      return element.text === undefined ? `[${element.shape}]` : `[${element.shape}] ${element.text}`;
    case "line":
      return element.endArrow === "arrow" || element.startArrow === "arrow" ? "[箭头]" : "[线]";
  }
}

/**
 * 「引用这一页 / 这个元素」→ 一条文件引用（`TextQuote` 的 filePath / slide / element）。纯函数。
 * 以页号与元素 id 为锚（不是行号）：.slides.json 是 JSON，行号对用户和模型都没意义。
 * 芯片写「文件名 · 第 n 页」（quote-label 按 slide 拼）；页号越界返回 null。
 */
export function quoteOfDeckPage(input: { path: string; deck: Deck; page: number; elementId?: string }): TextQuote | null {
  const slide = input.deck.slides[input.page - 1];
  if (slide === undefined) return null;
  const element = input.elementId === undefined ? undefined : slide.elements.find((each) => each.id === input.elementId);
  const source =
    element !== undefined
      ? elementPreview(element)
      : slide.elements.map(elementPreview).filter((line) => line.trim() !== "").join("\n");
  const preview = source.trim() === "" ? `(${slideTitle(slide) || "空白页"})` : source;
  const clamped = clampQuote(preview);
  return {
    text: clamped.text,
    messageId: "",
    role: "user",
    filePath: input.path,
    slide: input.page,
    ...(element === undefined ? {} : { element: element.id }),
    ...(clamped.truncated ? { truncated: true as const } : {}),
  };
}
