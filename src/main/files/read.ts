/**
 * `fs:read` 的实做（契约在 `shared/files.ts`）。**纯模块**（同 list.ts / roots.ts 的
 * 先例）：不 import electron，白名单校验在 ipc.ts 做完才把真实路径传进来，这里只管
 * 「给一条路径，读出预览」，`node --test` 能直接加载测。
 *
 * 读成什么由这里判：扩展名是 Chromium 的 `<img>` 画得了的图片格式 → 读成 base64；
 * 否则看开头 8 KB 有没有 NUL 字节——没有就当文本（`LICENSE`、`Makefile`、`.env` 这类
 * 没有扩展名的文本也能看），有就是二进制，不读内容。heic / tiff 等 Chromium 画不了的
 * 图片格式不在图片判定表里，自然落进二进制判定（这类容器格式开头基本都有 NUL）。
 */
import { open, readFile, stat } from "node:fs/promises";
import { type FilePreview, PREVIEW_IMAGE_LIMIT, PREVIEW_TEXT_LIMIT } from "../../shared/files.ts";

/** Chromium `<img>` 画得了的图片扩展名 → MIME（大小写不敏感，调用方先转小写）。 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** 「有没有 NUL 字节」判定只看开头这一段——与文本截断上限是两个独立的尺度 */
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface PreviewLimits {
  text: number;
  image: number;
}

const DEFAULT_LIMITS: PreviewLimits = { text: PREVIEW_TEXT_LIMIT, image: PREVIEW_IMAGE_LIMIT };

/** 名字里「扩展名」那一段：取最后一个 `.` 之后的部分，小写；无扩展名 / 点文件回空串 */
function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 读一个文件的预览。`limits` 只为测试注入小上限，生产路径用契约常量。
 * 调用方（ipc.ts）已经过白名单校验，这里拿到的 `path` 是 realpath 后的真实路径。
 */
export async function readPreview(path: string, limits: PreviewLimits = DEFAULT_LIMITS): Promise<FilePreview> {
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${path}`);
  }
  const size = stats.size;
  const modifiedAt = stats.mtimeMs;

  const mime = IMAGE_MIME[extOf(path)];
  if (mime !== undefined) {
    if (size > limits.image) {
      return { kind: "too-large", limit: limits.image, size, modifiedAt };
    }
    const buffer = await readFile(path);
    return { kind: "image", mime, base64: buffer.toString("base64"), size, modifiedAt };
  }

  // 只读开头 min(size, limits.text) 字节——再大的日志 / 数据文件不整份读进内存
  const readLength = Math.min(size, limits.text);
  const buffer = Buffer.alloc(readLength);
  let bytesRead = 0;
  if (readLength > 0) {
    const handle = await open(path, "r");
    try {
      ({ bytesRead } = await handle.read(buffer, 0, readLength, 0));
    } finally {
      await handle.close();
    }
  }
  const head = buffer.subarray(0, bytesRead);
  const sniffLength = Math.min(head.length, BINARY_SNIFF_BYTES);
  let binary = false;
  for (let i = 0; i < sniffLength; i++) {
    if (head[i] === 0) {
      binary = true;
      break;
    }
  }
  if (binary) {
    return { kind: "binary", size, modifiedAt };
  }
  const text = new TextDecoder("utf-8").decode(head);
  return { kind: "text", text, truncated: size > limits.text, size, modifiedAt };
}
