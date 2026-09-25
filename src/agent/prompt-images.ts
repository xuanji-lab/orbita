/**
 * 用户附图进 pi 之前的最后一道：准入复核 + 缩放。
 *
 * **为什么要缩**：pi 只给工具结果里的图做归一化（`normalizeToolResultImages`），
 * `prompt(text, { images })` 的图原样上送——一张 5K 截图 base64 后十几 MB，
 * provider 会把整条对话拒掉，而不只是这一轮。缩放用 pi 导出的 `resizeImage`
 * （2000px / 4.5MB，read 工具读图同一套口径），不自己再定一套尺寸策略。
 *
 * **为什么在 agent 进程做**：缩放是 CPU 活（pi 把它放进 worker 线程），
 * 主进程要留给窗口与 IPC；renderer 做的话缩放策略就得在浏览器里再实现一遍。
 *
 * 缩放后的图也是落盘的那份（transcript 回显用的就是它）——会话记录不存原图。
 */
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { PROMPT_IMAGE_MIME_TYPES, type PromptImage } from "../shared/prompt-images.ts";

export type ResizeImage = typeof resizeImage;

export async function preparePromptImages(
  images: readonly PromptImage[] | undefined,
  resize: ResizeImage = resizeImage,
): Promise<PromptImage[]> {
  if (images === undefined || images.length === 0) return [];
  const prepared: PromptImage[] = [];
  for (const [index, image] of images.entries()) {
    const label = `第 ${index + 1} 张图片`;
    // renderer 已拦过；这里再拦是因为载荷穿过两跳 IPC，renderer 不是唯一的信任边界
    if (!PROMPT_IMAGE_MIME_TYPES.includes(image.mimeType)) {
      throw new Error(`${label}的格式 ${image.mimeType} 不能直接发给模型，没有发送`);
    }
    const resized = await resize(Buffer.from(image.data, "base64"), image.mimeType);
    if (resized === null) {
      throw new Error(`${label}无法解码或压缩到上传上限以内，没有发送`);
    }
    prepared.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
  }
  return prepared;
}
