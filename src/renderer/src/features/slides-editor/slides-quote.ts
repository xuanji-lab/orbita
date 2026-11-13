import { clampQuote, type TextQuote } from "../../../../shared/quote.ts";
import { slideTitle } from "../../../../shared/slides-ops.ts";
import { richTextToPlain, type Deck, type ShapeKind, type SlideElement } from "../../../../shared/slides.ts";

/** 形状的中文名（芯片与引用正文里不露内部类型名 rect / roundRect） */
const SHAPE_NAME: Readonly<Record<ShapeKind, string>> = { rect: "矩形", roundRect: "圆角矩形", ellipse: "椭圆", triangle: "三角形" };

/** 粘贴 / 拖入的图是 `<uuid>.png`、`image-1.png` 这种生成名：露出来只是噪音 */
function isGeneratedName(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) || /^(?:image|img|pasted|screenshot|粘贴图)[\s_-]*\d*\.[a-z]+$/i.test(name);
}

/** 一个元素的文字预览（给人与模型看「这一页上有什么」；真结构让模型 slides_read）：图片用替代文字 / 文件名，形状用中文名 */
export function elementPreview(element: SlideElement): string {
  switch (element.kind) {
    case "text":
      return richTextToPlain(element.html);
    case "image": {
      const name = element.src.split("/").pop() ?? "";
      const label = (element.alt ?? "").trim() !== "" ? (element.alt as string).trim() : isGeneratedName(name) ? "" : name;
      return label === "" ? "[图片]" : `[图片 ${label}]`;
    }
    case "table":
      return `[表格 ${element.rows.length}×${element.rows[0]?.length ?? 0}] ${element.rows[0]?.join(" | ") ?? ""}`;
    case "shape": {
      const name = SHAPE_NAME[element.shape];
      return element.text === undefined ? `[${name}]` : `[${name}] ${element.text}`;
    }
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
