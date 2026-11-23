/**
 * 读音视频文件的时长（秒）——只读容器头，不解码、不起外部进程（ffprobe 不一定装，Windows 上更没有）。
 * 轮尾旁路扫描收到音视频候选后，在 agent 进程里顺手量一遍，随 fileTurn 报给主进程；量不到就不带，
 * 卡片也就不显示时长（「拿不到就不显示」）。
 *
 * 认得的容器：
 * - wav：fmt 块的 byteRate 与 data 块大小（流式写的 data 大小为 0 / 0xFFFFFFFF 时按文件剩余字节）；
 * - mp3：跳过 ID3v2，读第一帧头；有 Xing / Info / VBRI 帧数就按帧数算（VBR 精确），否则按 CBR 用「音频字节数 / 比特率」；
 * - mp4 / m4a / mov / m4v：顺顶层原子找 moov，读里面 mvhd 的 timescale 与 duration；
 * - flac：STREAMINFO 的总采样数与采样率。
 * ogg / opus / aac(ADTS) / webm 没有头里一眼能读的总时长，返回 null——宁可不显示，不猜。
 */
import { open, type FileHandle } from "node:fs/promises";

/** 读文件 [offset, offset+length) 的字节（读到文件末尾即止） */
async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

const positive = (seconds: number): number | null => (Number.isFinite(seconds) && seconds > 0 ? seconds : null);

/** wav：RIFF 块链里找 fmt 与 data */
export function wavDuration(head: Buffer, fileSize: number): number | null {
  if (head.length < 12 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return null;
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= head.length) {
    const id = head.toString("latin1", pos, pos + 4);
    const size = head.readUInt32LE(pos + 4);
    if (id === "fmt " && pos + 8 + 12 <= head.length) {
      byteRate = head.readUInt32LE(pos + 8 + 8);
    } else if (id === "data") {
      if (byteRate === 0) return null;
      const dataStart = pos + 8;
      const remaining = Math.max(0, fileSize - dataStart);
      // 流式写出的 wav 在头里把 data 大小写成 0 或 0xFFFFFFFF：按文件剩余字节算
      const bytes = size === 0 || size === 0xffffffff ? remaining : Math.min(size, remaining);
      return positive(bytes / byteRate);
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

const MP3_BITRATES: Readonly<Record<string, readonly number[]>> = {
  // [版本][层] 的 kbps 表，下标 = 头里的 bitrate index（0 与 15 无效）；只做 Layer III
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MP3_SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  1: [44100, 48000, 32000, 0],
  2: [22050, 24000, 16000, 0],
  25: [11025, 12000, 8000, 0],
};

/** mp3：ID3v2 之后的第一帧；Xing / Info / VBRI 给帧数，否则按 CBR */
export function mp3Duration(head: Buffer, fileSize: number): number | null {
  let pos = 0;
  if (head.length >= 10 && head.toString("latin1", 0, 3) === "ID3") {
    const size = ((head[6] ?? 0) << 21) | ((head[7] ?? 0) << 14) | ((head[8] ?? 0) << 7) | (head[9] ?? 0);
    pos = 10 + size;
  }
  const audioStart = pos;
  // 找帧同步（11 个 1）；头不全 / 找太远就放弃
  for (let scan = 0; pos + 4 <= head.length && scan < 4096; scan += 1, pos += 1) {
    const b0 = head[pos] ?? 0;
    const b1 = head[pos + 1] ?? 0;
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) continue;
    const versionBits = (b1 >> 3) & 3; // 0 = 2.5，2 = 2，3 = 1，1 保留
    const layerBits = (b1 >> 1) & 3; // 1 = Layer III
    if (versionBits === 1 || layerBits !== 1) continue;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
    const b2 = head[pos + 2] ?? 0;
    const bitrate = (MP3_BITRATES[`${version === 1 ? 1 : 2}-3`] ?? [])[b2 >> 4] ?? 0;
    const sampleRate = (MP3_SAMPLE_RATES[version] ?? [])[(b2 >> 2) & 3] ?? 0;
    if (bitrate === 0 || sampleRate === 0) continue;
    const samplesPerFrame = version === 1 ? 1152 : 576;
    const mono = (((head[pos + 3] ?? 0) >> 6) & 3) === 3;
    // Xing / Info 在帧头 + 侧信息之后；VBRI 固定在帧头后 32 字节
    const sideInfo = version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xing = pos + 4 + sideInfo;
    const tag = head.toString("latin1", xing, xing + 4);
    if ((tag === "Xing" || tag === "Info") && xing + 12 <= head.length && ((head[xing + 7] ?? 0) & 1) === 1) {
      return positive((head.readUInt32BE(xing + 8) * samplesPerFrame) / sampleRate);
    }
    const vbri = pos + 4 + 32;
    if (head.toString("latin1", vbri, vbri + 4) === "VBRI" && vbri + 18 <= head.length) {
      return positive((head.readUInt32BE(vbri + 14) * samplesPerFrame) / sampleRate);
    }
    const audioBytes = Math.max(0, fileSize - Math.max(audioStart, pos));
    return positive((audioBytes * 8) / (bitrate * 1000));
  }
  return null;
}

/** flac：fLaC + STREAMINFO（采样率 20 位、总采样数 36 位） */
export function flacDuration(head: Buffer): number | null {
  if (head.length < 26 || head.toString("latin1", 0, 4) !== "fLaC") return null;
  const sampleRate = ((head[18] ?? 0) << 12) | ((head[19] ?? 0) << 4) | ((head[20] ?? 0) >> 4);
  const totalSamples = ((head[21] ?? 0) & 0x0f) * 2 ** 32 + head.readUInt32BE(22);
  if (sampleRate === 0 || totalSamples === 0) return null;
  return positive(totalSamples / sampleRate);
}

/** mvhd 原子体（含 8 字节头）里的时长：v0 为 32 位，v1 为 64 位 */
export function mvhdDuration(box: Buffer): number | null {
  if (box.length < 28) return null;
  const version = box[8] ?? 0;
  if (version === 1) {
    if (box.length < 40) return null;
    const timescale = box.readUInt32BE(28);
    const duration = Number(box.readBigUInt64BE(32));
    return timescale === 0 ? null : positive(duration / timescale);
  }
  const timescale = box.readUInt32BE(20);
  const duration = box.readUInt32BE(24);
  return timescale === 0 ? null : positive(duration / timescale);
}

/** mp4 / mov / m4a：顶层原子里找 moov，再在它开头找 mvhd */
async function mp4Duration(handle: FileHandle, fileSize: number): Promise<number | null> {
  let pos = 0;
  // 顶层原子个数有限（ftyp / free / mdat / moov）；上限防畸形文件把循环拖长
  for (let hops = 0; hops < 64 && pos + 8 <= fileSize; hops += 1) {
    const header = await readAt(handle, pos, 16);
    if (header.length < 8) return null;
    let size = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    if (size === 1 && header.length >= 16) size = Number(header.readBigUInt64BE(8));
    else if (size === 0) size = fileSize - pos;
    if (size < 8) return null;
    if (type === "moov") {
      const body = await readAt(handle, pos + 8, Math.min(size - 8, 4096));
      const at = body.indexOf("mvhd", 0, "latin1");
      if (at < 4) return null;
      return mvhdDuration(body.subarray(at - 4));
    }
    pos += size;
  }
  return null;
}

/** 读一个音视频文件的时长（秒）；认不得的容器 / 读不了 / 头不全一律 null */
export async function readMediaDuration(path: string): Promise<number | null> {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const fileSize = (await handle.stat()).size;
    if (ext === "mp4" || ext === "m4a" || ext === "mov" || ext === "m4v") return await mp4Duration(handle, fileSize);
    const head = await readAt(handle, 0, 64 * 1024);
    if (ext === "wav") return wavDuration(head, fileSize);
    if (ext === "mp3") return mp3Duration(head, fileSize);
    if (ext === "flac") return flacDuration(head);
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** 一批文件的时长：逐个量，量不到的缺席（返回与路径一一对应的 { path, duration? }） */
export async function measureMedia(paths: readonly string[]): Promise<{ path: string; duration?: number }[]> {
  const out: { path: string; duration?: number }[] = [];
  for (const path of paths) {
    const duration = await readMediaDuration(path);
    out.push(duration === null ? { path } : { path, duration: Math.round(duration * 10) / 10 });
  }
  return out;
}
