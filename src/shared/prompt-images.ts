/**
 * 用户消息附带的图片——契约与准入规则。
 *
 * 形状就是 pi 的 `ImageContent`（`{ type: "image", data: base64, mimeType }`）：
 * pi 的 `prompt(text, { images })` 与协议的 user 内容块收的都是它，我们不另造一层。
 *
 * 准入规则放在 shared，因为有两个消费者：renderer 在图片进输入框之前就拦
 * （用户当场看到哪张不行、为什么），agent 进程在交给 pi 之前再拦一道
 * （renderer 不是唯一的信任边界——载荷穿过两跳 IPC）。两边各写一份迟早漂移。
 */
import type { ImageContent } from "@earendil-works/pi-protocol";

export type PromptImage = ImageContent;

/**
 * 能直接发给模型的格式。**与 pi 的 `processImage` 认的那四种一致**：各家 API
 * 都只收这几种，别的（HEIC、TIFF、SVG）要先转码——转码不在这一刀的范围里，
 * 与其发出去被上游拒掉整条对话，不如在门口说清楚。
 */
export const PROMPT_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * 原图体积上限（压缩前）。进 agent 进程后会按 pi 的口径缩到 2000px / 4.5MB 以内
 * （`resizeImage`，与 read 工具读图同一套），所以这不是模型的上限，
 * 是「一张图值不值得 base64 过两跳 IPC」的上限——30MB 的原图多半是误拖进来的。
 */
export const PROMPT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

/** 一条消息最多几张。多了既贵又慢，模型也看不过来。 */
export const PROMPT_IMAGE_MAX_COUNT = 10;

export type PromptImageRejection = "unsupported" | "too-large";

/** 一张图能不能进输入框。null = 可以 */
export function checkPromptImage(file: { type: string; size: number }): PromptImageRejection | null {
  if (!PROMPT_IMAGE_MIME_TYPES.includes(file.type)) return "unsupported";
  if (file.size > PROMPT_IMAGE_MAX_BYTES) return "too-large";
  return null;
}
