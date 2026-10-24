/**
 * docx 包的**最小**改写器：只替换被点名的条目，其余条目连压缩后的字节一起原样搬运。
 *
 * 为什么不用 jszip 重新打包：`generateAsync` 会把每个条目解压再压一遍，图片、字体、
 * 主题这些与本次改动无关的条目也会换掉字节（图片 5 MB 的文档每次保存都要重压一遍）。
 * 走「读中央目录 → 逐条复制原始记录」这条路，改动只落在真正要改的那几个 XML 上，
 * 别的内容一个字节都不动，Word 打开时的结果也就与保存前一致。
 *
 * 范围与限制（够 docx 用，不做通用 zip 库）：
 * - 不支持 ZIP64 / 分卷（docx 上限 50 MB，`shared/docx.ts` 先拦了）；
 * - 不支持加密条目（加密 docx 在 `read.ts` 就判成 `password`，到不了这里）；
 * - 条目名按 UTF-8 解码（docx 里的条目名都是 ASCII）；
 * - 条目顺序沿用中央目录的顺序，条目时间戳沿用原值。
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 通用位标记：bit 3 = 头部的 crc/大小是 0、真实值在数据后面的 descriptor 里 */
const FLAG_DATA_DESCRIPTOR = 0x0008;

interface ZipEntryHeader {
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  versionMadeBy: number;
  versionNeeded: number;
  internalAttr: number;
  externalAttr: number;
  localOffset: number;
  /** 中央目录里的 extra（保持原样，ZIP64 记录会被丢掉——见文件头） */
  extra: Uint8Array;
  comment: Uint8Array;
  /** 本地头里的 extra，可能与中央目录那份不同 */
  localExtra: Uint8Array;
  /** 本地头的文件名长度（与中央目录那份可能不同），定位数据起点用 */
  localNameLength: number;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 从尾部找 EOCD（可能带归档注释，最长 65535 字节） */
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (i + 22 + commentLength === view.byteLength) return i;
  }
  return -1;
}

/** ZIP64 的 extra 记录（id 0x0001）在重写之后会指向旧偏移，直接丢掉 */
function stripZip64Extra(extra: Uint8Array): Uint8Array {
  const out: number[] = [];
  const view = viewOf(extra);
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = view.getUint16(i, true);
    const length = view.getUint16(i + 2, true);
    const end = i + 4 + length;
    if (end > extra.length) break;
    if (id !== 0x0001) for (let byte = i; byte < end; byte += 1) out.push(extra[byte]!);
    i = end;
  }
  return Uint8Array.from(out);
}

/**
 * 读中央目录。条目顺序、条目名、压缩方式、时间戳全从这里取：本地头可能与它不一致
 * （data descriptor 的条目在本地头里大小是 0），中央目录才是权威。
 */
function readCentralDirectory(bytes: Uint8Array): { entries: ZipEntryHeader[]; names: string[] } {
  const view = viewOf(bytes);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error("zip: 找不到中央目录结尾");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("zip: 不支持 ZIP64");
  }
  if (cdOffset + cdSize > bytes.length) throw new Error("zip: 中央目录越界");

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntryHeader[] = [];
  const names: string[] = [];
  let at = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIG_CENTRAL) {
      throw new Error("zip: 中央目录条目损坏");
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const nameStart = at + 46;
    const extraStart = nameStart + nameLength;
    const commentStart = extraStart + extraLength;
    const nameBytes = bytes.subarray(nameStart, extraStart);
    const localOffset = view.getUint32(at + 42, true);
    if (localOffset + 30 > bytes.length) throw new Error("zip: 本地头越界");

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);

    names.push(decoder.decode(nameBytes));
    entries.push({
      nameBytes,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      versionMadeBy: view.getUint16(at + 4, true),
      versionNeeded: view.getUint16(at + 6, true),
      internalAttr: view.getUint16(at + 36, true),
      externalAttr: view.getUint32(at + 38, true),
      localOffset,
      extra: stripZip64Extra(bytes.subarray(extraStart, commentStart)),
      comment: bytes.subarray(commentStart, commentStart + commentLength),
      localExtra: bytes.subarray(localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + localExtraLength),
      localNameLength,
    });
    at = commentStart + commentLength;
  }
  return { entries, names };
}

/** 未压缩数据的物理位置 */
function dataStartOf(header: ZipEntryHeader): number {
  return header.localOffset + 30 + header.localNameLength + header.localExtra.length;
}

function inflateEntry(bytes: Uint8Array, header: ZipEntryHeader): Uint8Array {
  const start = dataStartOf(header);
  const raw = bytes.subarray(start, start + header.compressedSize);
  if (header.method === 0) return raw;
  if (header.method === 8) return inflateRawSync(raw);
  throw new Error(`zip: 不支持的压缩方式 ${header.method}`);
}

/** 读一个条目的文本内容；条目不存在返回 null。只给少量 XML 用，不适合整包扫描 */
export function readZipEntryText(bytes: Uint8Array, name: string): string | null {
  let entries: ZipEntryHeader[];
  let names: string[];
  try {
    ({ entries, names } = readCentralDirectory(bytes));
  } catch {
    return null;
  }
  const index = names.indexOf(name);
  if (index < 0) return null;
  try {
    return new TextDecoder("utf-8").decode(inflateEntry(bytes, entries[index]!));
  } catch {
    return null;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 按 `targets` 点名改写条目内容。`transform` 收到条目的 UTF-8 文本，返回新文本表示要改，
 * 返回 null（或原样返回）表示不动——**没改的条目连压缩后的字节都不重算**。
 * 结构性问题（不是 zip / ZIP64 / 头部损坏）抛错，由调用方决定要不要退回原字节。
 */
export function rewriteZipEntries(
  bytes: Uint8Array,
  targets: readonly string[],
  transform: (name: string, text: string) => string | null,
): Uint8Array {
  const { entries, names } = readCentralDirectory(bytes);
  const wanted = new Set(targets);
  const chunks: Buffer[] = [];
  let offset = 0;
  const emit = (chunk: Buffer): void => {
    chunks.push(chunk);
    offset += chunk.length;
  };

  const written: { header: ZipEntryHeader; crc: number; compressedSize: number; uncompressedSize: number; localOffset: number }[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const header = entries[index]!;
    const name = names[index]!;
    if (viewOf(bytes).getUint32(header.localOffset, true) !== SIG_LOCAL) {
      throw new Error(`zip: 条目 ${name} 的本地头损坏`);
    }

    let data: Uint8Array;
    let crc = header.crc;
    let compressedSize = header.compressedSize;
    let uncompressedSize = header.uncompressedSize;
    let method = header.method;

    let original: string | null = null;
    let next: string | null = null;
    if (wanted.has(name)) {
      original = new TextDecoder("utf-8").decode(inflateEntry(bytes, header));
      next = transform(name, original);
    }
    if (next !== null && next !== original) {
      const raw = new TextEncoder().encode(next);
      method = header.method === 0 ? 0 : 8;
      data = method === 0 ? raw : deflateRawSync(raw);
      crc = crc32(raw);
      compressedSize = data.length;
      uncompressedSize = raw.length;
    } else {
      const start = dataStartOf(header);
      data = bytes.subarray(start, start + header.compressedSize);
    }

    const flags = header.flags & ~FLAG_DATA_DESCRIPTOR;
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(header.versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(header.time, 10);
    local.writeUInt16LE(header.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(header.nameBytes.length, 26);
    local.writeUInt16LE(header.localExtra.length, 28);
    emit(local);
    emit(Buffer.from(header.nameBytes));
    emit(Buffer.from(header.localExtra));
    emit(Buffer.from(data));
    written.push({ header, crc, compressedSize, uncompressedSize, localOffset });
  }

  const centralOffset = offset;
  for (const entry of written) {
    const header = entry.header;
    const central = Buffer.alloc(46 + header.nameBytes.length + header.extra.length + header.comment.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(header.versionMadeBy, 4);
    central.writeUInt16LE(header.versionNeeded, 6);
    central.writeUInt16LE(header.flags & ~FLAG_DATA_DESCRIPTOR, 8);
    central.writeUInt16LE(header.method, 10);
    central.writeUInt16LE(header.time, 12);
    central.writeUInt16LE(header.date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(header.nameBytes.length, 28);
    central.writeUInt16LE(header.extra.length, 30);
    central.writeUInt16LE(header.comment.length, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(header.internalAttr, 36);
    central.writeUInt32LE(header.externalAttr, 38);
    central.writeUInt32LE(entry.localOffset, 42);
    let at = 46;
    for (const part of [header.nameBytes, header.extra, header.comment]) {
      central.set(part, at);
      at += part.length;
    }
    emit(central);
  }

  const centralSize = offset - centralOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(written.length, 8);
  eocd.writeUInt16LE(written.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  emit(eocd);

  const out = Buffer.concat(chunks);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

