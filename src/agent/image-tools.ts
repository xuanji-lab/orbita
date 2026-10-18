import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import * as ncanvas from "@napi-rs/canvas";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * agent 的图片展示工具：show_image。
 *
 * 「读图」与「展示」是两个动作（Claude Code 的公开 issue：模型把用户的「看看这张图」
 * 理解成 read——模型自己看见了，用户终端里只有一行文字摘要）。本工具补上后半个
 * 动作：模型显式调用 = 「这几张图请用户过目」。
 *
 * **卡片数据走 details、模型视野走 content**（两条通道各司其职）：
 * - content 的 image 块只服务模型——视觉模型一跳两得（看得见、可继续评论）；
 *   非视觉模型按 read 读图的先例省略 image 块（带 note），provider 不炸
 * - details.showImage 永远带全量图片（明文语义「只给 UI、不入模型上下文」，
 *   read_task 卡 / edit diff 同一先例）——renderer 靠它画会话流大图卡，
 *   与模型有没有视觉无关
 *
 * 准入：魔数认 png/jpeg/gif/webp 四种（各家 API 内联都只收这几种，转码不在
 * 这一刀内）；单张 ≤30MB（prompt-images 的同款上限——超出多半是误选）。
 * 读盘在 agent 进程直读（与 read / read_pdf 同一信任边界），零副作用——
 * READ_ONLY_TOOLS 收编。
 */

/** 一次最多展示几张。画廊形态的排版上限，多了刷屏 */
export const SHOW_IMAGE_MAX_COUNT = 6;

/** 单张体积上限（与 PROMPT_IMAGE_MAX_BYTES 同口径） */
export const SHOW_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

/**
 * 转录内图片的长边上限。原图 base64 会**双份**进会话 JSONL（content 的 image 块
 * + details 的画廊卡），一张 5MB 照片就是 13MB×2——用户附图的先例纪律是「转录
 * 不存原图」。png/jpeg 超长边时缩放重编码（@napi-rs/canvas，与渲染同库）；gif
 * 不做（loadImage 不保证支持动图解码，30MB 准入兜底），webp 同 png 路径。
 */
export const SHOW_IMAGE_MAX_EDGE = 2000;

/**
 * 缩放超长边的 png/webp（或 jpeg）。不超限或加载失败时原样返回——展示不该因转码挂掉。
 * maxEdge 参数化：show_image 传自己的上限，read_docx 的内嵌图转录纪律同款复用
 */
export async function shrinkIfNeeded(
  buffer: Buffer,
  mimeType: string,
  maxEdge: number = SHOW_IMAGE_MAX_EDGE,
): Promise<{ data: string; mimeType: string }> {
  if (mimeType !== "image/png" && mimeType !== "image/webp" && mimeType !== "image/jpeg") {
    return { data: buffer.toString("base64"), mimeType };
  }
  try {
    const bitmap = await ncanvas.loadImage(buffer);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= maxEdge) return { data: buffer.toString("base64"), mimeType };
    const scale = maxEdge / longEdge;
    const canvas = ncanvas.createCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encoded =
      mimeType === "image/jpeg" ? await canvas.encode("jpeg", 90) : await canvas.encode("png");
    return { data: Buffer.from(encoded).toString("base64"), mimeType };
  } catch {
    // 解码不了就原样给——魔数已过准入，交给 provider / img 渲染各自报错
    return { data: buffer.toString("base64"), mimeType };
  }
}

/** details 上的卡片载荷：renderer 渲染会话流图卡的真源 */
export interface ShowImageCard {
  images: { data: string; mimeType: string; name: string }[];
}

/** 魔数→MIME。扩展名会说谎，文件头不会（read_pdf 同一教训）；read_docx 的内嵌图同款准入 */
export function imageMimeOf(head: Buffer): string | null {
  if (head.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

export function createImageTools(cwd: string): ToolDefinition[] {
  const showImage: ToolDefinition = {
    name: "show_image",
    label: "show_image",
    description:
      "Show images to the user in the conversation — for figures you cropped from a PDF, pictures in a " +
      "folder, generated files, anything the user should look at with their own eyes. Pass 1-6 image file " +
      "paths; they render as a gallery card in the chat. You also receive the images yourself (on vision " +
      "models), so you can keep talking about them. Reading an image for yourself only (user does not " +
      "need to see it) is the read tool's job — do not call show_image for that.",
    promptGuidelines: [
      "When the user should see an image with their own eyes (figures you cropped from a PDF, pictures in a " +
        "folder, generated files), show it with show_image instead of only describing it.",
    ],
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Image file paths (png / jpg / gif / webp), 1-6 of them.",
        },
      },
      required: ["paths"],
    } as never,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = (params ?? {}) as Record<string, unknown>;
      const raw = Array.isArray(args["paths"]) ? args["paths"] : [];
      const paths = raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      if (paths.length === 0) throw new Error('show_image requires "paths" with 1-6 image file paths');
      if (paths.length > SHOW_IMAGE_MAX_COUNT) {
        throw new Error(`At most ${SHOW_IMAGE_MAX_COUNT} images per call (got ${paths.length}).`);
      }

      const images: { data: string; mimeType: string; name: string }[] = [];
      for (const path of paths) {
        const absolute = isAbsolute(path) ? path : join(cwd, path);
        const buffer = await readFile(absolute);
        if (buffer.length > SHOW_IMAGE_MAX_BYTES) {
          throw new Error(`${path} is larger than 30MB — too big to display.`);
        }
        const mimeType = imageMimeOf(buffer.subarray(0, 12));
        if (mimeType === null) {
          throw new Error(`${path} is not a supported image (png / jpg / gif / webp).`);
        }
        // 缩到转录友好的尺寸；content 与 details 共用这一份 base64（不再双存原图）
        const shrunk = await shrinkIfNeeded(buffer, mimeType);
        images.push({ data: shrunk.data, mimeType: shrunk.mimeType, name: basename(path) });
      }

      // 模型视野：视觉模型带 image 块（一跳两得）；非视觉省略 + read 同款 note。
      // details 永远带全量图片给 UI（用户的画廊不随模型视力消失）
      const canSee = ctx?.model?.input.includes("image") ?? false;
      const shown = `Showing ${images.length} image${images.length > 1 ? "s" : ""} to the user: ${images
        .map((img) => img.name)
        .join(", ")}.`;
      const modelContent: (
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      )[] = canSee
        ? [
            { type: "text", text: `${shown} They are attached below for you too.` },
            ...images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
          ]
        : [
            {
              type: "text",
              text: `${shown} [Current model does not support images. The image will be omitted from this request.]`,
            },
          ];
      return { content: modelContent, details: { showImage: { images } satisfies ShowImageCard } };
    },
  };
  return [showImage];
}
