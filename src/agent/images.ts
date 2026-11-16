/**
 * 发给模型的图：缩放、转格式、坐标提示。
 *
 * 处理器是新运行时自带的 photon（WASM）实现，进程里懒加载一次、在本线程里做（不开 worker：打包后
 * worker 入口找不到）。三个入口共用它：read 工具读图（durable 自己调）、工具结果里的图
 * （normalizeToolResultImages）、用户随消息发的图（prompt-images.ts 的 resizePromptImage）。
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits, type ImageProcessor, type PreparedImage } from "@earendil-works/pi-durable/tools";

let photon: Promise<ImageProcessor> | undefined;

/** 进程内唯一的图片处理器（第一次用到才加载 WASM） */
export const imageProcessor: ImageProcessor = {
  async prepare(bytes, mimeType, limits) {
    photon ??= createNodePhotonImages({ worker: false });
    return (await photon).prepare(bytes, mimeType, limits);
  },
};

/** 不缩、只把 provider 不收的格式（BMP 等）转成 PNG：设置里关了自动缩放时用 */
const CONVERT_ONLY: ImageLimits = { maxWidth: Number.MAX_SAFE_INTEGER, maxHeight: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER };

/** 缩过 / 转过格式时给模型的一行说明（与 read 工具读图的说明同措辞，坐标换算是点图类工具要用的） */
export function preparedImageNote(prepared: PreparedImage): string | undefined {
  const notes: string[] = [];
  if (prepared.convertedFrom !== undefined) notes.push(`Converted from ${prepared.convertedFrom} to ${prepared.mimeType}.`);
  if (prepared.resized !== undefined) {
    const { from, to } = prepared.resized;
    notes.push(`Resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${(from.width / to.width).toFixed(2)} to map them to the original.`);
  }
  return notes.length === 0 ? undefined : `[Image: ${notes.join(" ")}]`;
}

export interface ToolImageOptions {
  /** ~/.pi/agent/settings.json 的 images.autoResize（缺省开） */
  autoResizeImages: boolean;
  /** 这一轮模型的图片上限（Model.inputLimits.images.resize）；缺席用默认 2000x2000 / 4.5MB */
  limits?: Partial<ImageLimits>;
  processor?: ImageProcessor;
}

/**
 * 工具结果里的图进历史前过一道：超过模型上限的缩小，provider 不收的格式转 PNG，变了就在图后面接一行说明。
 * 一张超大的图会让 provider 拒掉整条对话（不只是这一轮），所以在它进历史的那一刻处理。
 * 处理失败（解不开、压不下）保留原图：图是工具自己产出的，悄悄删掉比原样留着更糟。没有任何变化时返回原数组。
 */
export async function normalizeToolResultImages(
  content: readonly (TextContent | ImageContent)[],
  options: ToolImageOptions,
): Promise<(TextContent | ImageContent)[]> {
  if (!content.some((block) => block.type === "image")) return [...content];
  const processor = options.processor ?? imageProcessor;
  const limits = options.autoResizeImages ? { ...DEFAULT_IMAGE_LIMITS, ...options.limits } : CONVERT_ONLY;
  const out: (TextContent | ImageContent)[] = [];
  for (const block of content) {
    if (block.type !== "image") {
      out.push(block);
      continue;
    }
    let prepared: PreparedImage | undefined;
    try {
      prepared = await processor.prepare(Buffer.from(block.data, "base64"), block.mimeType, limits);
    } catch {
      prepared = undefined;
    }
    if (prepared === undefined) {
      out.push(block);
      continue;
    }
    out.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
    const note = preparedImageNote(prepared);
    if (note !== undefined) out.push({ type: "text", text: note });
  }
  return out;
}

/** 用户随消息发的图：按默认上限缩（与 read 读图同口径）；解不开或压不下返回 null */
export async function resizePromptImage(bytes: Uint8Array, mimeType: string, processor: ImageProcessor = imageProcessor): Promise<{ data: string; mimeType: string } | null> {
  try {
    const prepared = await processor.prepare(bytes, mimeType, DEFAULT_IMAGE_LIMITS);
    return prepared === undefined ? null : { data: prepared.data, mimeType: prepared.mimeType };
  } catch {
    return null;
  }
}
