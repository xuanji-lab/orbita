/**
 * 读图片原始尺寸与格式——只看文件头，不解码（几十 MB 的图也是微秒级）。
 * 认 PNG / JPEG / GIF / WebP（VP8 / VP8L / VP8X）；魔数定身份，不信扩展名。
 * 认不出 / 头被截断 = null（调用方退回「放一个 4:3 的框」，不报错）。
 */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}

export const IMAGE_MIME: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (at: number): number => (at < bytes.length ? (bytes[at] as number) : -1);
  // PNG：8 字节签名 + IHDR（宽高各 4 字节大端）
  if (bytes.length >= 24 && u8(0) === 0x89 && u8(1) === 0x50 && u8(2) === 0x4e && u8(3) === 0x47) {
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF：GIF8 + 宽高各 2 字节小端
  if (bytes.length >= 10 && u8(0) === 0x47 && u8(1) === 0x49 && u8(2) === 0x46 && u8(3) === 0x38) {
    return { format: "gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // JPEG：FFD8，扫段找 SOFn（C0–CF 里除 C4 / C8 / CC）
  if (bytes.length >= 4 && u8(0) === 0xff && u8(1) === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (u8(at) !== 0xff) {
        at += 1;
        continue;
      }
      const marker = u8(at + 1);
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      at += 2 + view.getUint16(at + 2);
    }
    return null;
  }
  // WebP：RIFF....WEBP
  if (bytes.length >= 30 && u8(0) === 0x52 && u8(1) === 0x49 && u8(2) === 0x46 && u8(3) === 0x46 && u8(8) === 0x57 && u8(9) === 0x45 && u8(10) === 0x42 && u8(11) === 0x50) {
    const kind = String.fromCharCode(u8(12), u8(13), u8(14), u8(15));
    if (kind === "VP8 ") return { format: "webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") {
      const bits = view.getUint32(21, true);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") {
      const w = (u8(24) | (u8(25) << 8) | (u8(26) << 16)) + 1;
      const h = (u8(27) | (u8(28) << 8) | (u8(29) << 16)) + 1;
      return { format: "webp", width: w, height: h };
    }
  }
  return null;
}
