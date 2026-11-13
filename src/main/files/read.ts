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
import {
  type FilePreview,
  type PdfFile,
  PREVIEW_BINARY_SNIFF_BYTES,
  PREVIEW_IMAGE_LIMIT,
  PREVIEW_PDF_LIMIT,
  PREVIEW_TEXT_LIMIT,
} from "../../shared/files.ts";

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

export interface PreviewLimits {
  text: number;
  image: number;
}

const DEFAULT_LIMITS: PreviewLimits = { text: PREVIEW_TEXT_LIMIT, image: PREVIEW_IMAGE_LIMIT };

/**
 * 截断时退掉末尾被切一半的 UTF-8 序列，返回「最后一个完整字符之后」的字节长度。
 *
 * 按字节截断（`min(size, limit)`）会正好切在多字节字符中间，`TextDecoder` 只能把它
 * 补成 `U+FFFD`——CJK 文件在边界上就多一个乱码方块（2026-10-25 实测：8 MB 中文
 * 文件截到 2 MB，末字符即 `U+FFFD`）。UTF-8 的一个序列是「首字节说明长度 + 最多 3 个
 * 续字节（0x80–0xBF）」，所以从末尾往回最多看 4 个字节就能判断最后那个序列是否完整：
 * 不完整就从它的首字节处截掉（最多少 3 个字节）。数据本身非法（长度够但字节不合法）
 * 不在这里修，交给 TextDecoder 的默认行为。
 */
function completeUtf8End(buf: Buffer): number {
  let start = buf.length - 1;
  let continuations = 0;
  while (start >= 0 && continuations < 3 && ((buf[start] ?? 0) & 0xc0) === 0x80) {
    start -= 1;
    continuations += 1;
  }
  // 整段都是续字节：那不是「末尾被切」造成的，别动它
  if (start < 0) return buf.length;
  const lead = buf[start] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need === 1) return buf.length; // 末尾是 ASCII，天然完整
  return buf.length - start >= need ? buf.length : start;
}

/** 名字里「扩展名」那一段：取最后一个 `.` 之后的部分，小写；无扩展名 / 点文件回空串 */
function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 开头有没有 NUL 字节（只看前 PREVIEW_BINARY_SNIFF_BYTES 个） */
function hasNul(head: Buffer): boolean {
  const sniffLength = Math.min(head.length, PREVIEW_BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLength; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}

/** 读文件开头 `length` 字节（`length` 为 0 不开文件） */
async function readHead(path: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 读一个文件的预览。`limits` 只为测试注入小上限，生产路径用契约常量。
 * 调用方（ipc.ts）已经过白名单校验，这里拿到的 `path` 是 realpath 后的真实路径。
 *
 * 文本比 `limits.text` 大时**不读正文**：只嗅开头 8 KB 判二进制，回 `large-text`，面板
 * 随后走按行取窗。以前这里先读前 16 MB 再让 renderer 丢掉（100 MB 日志白搬 16 MB 过 IPC），
 * 只有「超长单行」那条退路用得上——它现在改由 `readTextHead` 按需读。
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

  const large = size > limits.text;
  const head = await readHead(path, large ? Math.min(size, PREVIEW_BINARY_SNIFF_BYTES) : size);
  if (hasNul(head)) {
    return { kind: "binary", size, modifiedAt };
  }
  if (large) return { kind: "large-text", size, modifiedAt };
  return { kind: "text", text: new TextDecoder("utf-8").decode(head), size, modifiedAt };
}

/**
 * 读文本开头至多 `limit` 字节并解码（边界落在多字节字符中间就退掉那半个）。
 * 只给分段预览的「超长单行」退路用：一条行没法再窗口化，只能退回看前 16 MB。
 */
export async function readTextHead(path: string, limit: number = PREVIEW_TEXT_LIMIT): Promise<string> {
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${path}`);
  }
  const head = await readHead(path, Math.min(stats.size, limit));
  const end = stats.size > limit ? completeUtf8End(head) : head.length;
  return new TextDecoder("utf-8").decode(head.subarray(0, end));
}

/**
 * 读一个 PDF 的整份字节（`fs:read-pdf`，实验功能「PDF 引用」的预览面板）。调用方
 * 已过白名单并确认扩展名；这里只管大小上限。`limit` 只为测试注入。
 * 回 Uint8Array 而不是 Buffer：Buffer 过 IPC 结构化克隆后也是 Uint8Array，契约上
 * 直接写成它，renderer 交给 pdf.js 不必再转。
 */
export async function readPdfFile(path: string, limit: number = PREVIEW_PDF_LIMIT): Promise<PdfFile> {
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${path}`);
  }
  if (stats.size > limit) {
    return { kind: "too-large", limit, size: stats.size, modifiedAt: stats.mtimeMs };
  }
  const buffer = await readFile(path);
  return {
    kind: "pdf",
    data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    size: stats.size,
    modifiedAt: stats.mtimeMs,
  };
}
