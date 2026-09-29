/**
 * 豆包大模型流式语音识别的二进制帧（火山引擎公开文档「大模型流式语音识别 API」）。纯函数，
 * 只依赖 node:zlib，node --test 直接加载。
 *
 * 帧 = 4 字节头 + [4 字节序号] + 4 字节负载长度（大端）+ 负载。头的四个字节：
 *   byte0  高 4 位协议版本（1）、低 4 位头长度（以 4 字节为单位，1 = 4 字节）
 *   byte1  高 4 位消息类型、低 4 位标志
 *   byte2  高 4 位序列化方式、低 4 位压缩方式
 *   byte3  保留
 * 服务端的错误帧没有负载长度，换成 4 字节错误码 + 4 字节消息长度 + 消息。
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { DICTATION_SAMPLE_RATE } from "../../shared/voice.ts";

const VERSION = 0b0001;
const HEADER_WORDS = 0b0001;

const TYPE_FULL_CLIENT_REQUEST = 0b0001;
const TYPE_AUDIO_ONLY = 0b0010;
const TYPE_FULL_SERVER_RESPONSE = 0b1001;
const TYPE_SERVER_ERROR = 0b1111;

/** 标志位：bit0 = 带序号，bit1 = 最后一包 */
const FLAG_HAS_SEQUENCE = 0b0001;
const FLAG_LAST = 0b0010;

const SERIALIZE_NONE = 0b0000;
const SERIALIZE_JSON = 0b0001;
const COMPRESS_GZIP = 0b0001;

export const ASR_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

/**
 * 停顿多久算一句话说完（毫秒）。听写的人会停下来想，默认的 800 ms 太短——话没说完就被切成
 * 两句，标点也跟着断在半截。
 */
const END_WINDOW_MS = 5000;

function frame(type: number, flags: number, serialization: number, payload: Buffer): Buffer {
  const header = Buffer.from([
    (VERSION << 4) | HEADER_WORDS,
    (type << 4) | flags,
    (serialization << 4) | COMPRESS_GZIP,
    0,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

/** 连接建立后的第一帧：音频格式与识别参数（JSON，gzip） */
export function startFrame(uid: string): Buffer {
  const request = {
    user: { uid },
    audio: { format: "pcm", codec: "raw", rate: DICTATION_SAMPLE_RATE, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      // 每次回全量文本（不是增量）：renderer 直接替换，不用自己拼
      result_type: "full",
      show_utterances: true,
      // 数字规整、标点、顺滑（去掉「嗯」「那个」这类口头禅）
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      // 二遍识别：一句话说完后用非流式模型再认一遍，最终文字更准
      enable_nonstream: true,
      end_window_size: END_WINDOW_MS,
    },
  };
  return frame(TYPE_FULL_CLIENT_REQUEST, 0, SERIALIZE_JSON, gzipSync(Buffer.from(JSON.stringify(request), "utf8")));
}

/** 一段音频；last = 这是最后一包（可以是空的），服务端据此给出最终结果并收尾 */
export function audioFrame(pcm: Uint8Array, last: boolean): Buffer {
  return frame(TYPE_AUDIO_ONLY, last ? FLAG_LAST : 0, SERIALIZE_NONE, gzipSync(pcm));
}

export type ServerMessage =
  | { kind: "result"; text: string; final: boolean }
  | { kind: "error"; code: number; message: string };

interface Utterance {
  text?: unknown;
}

/**
 * 服务端的一帧 → 识别结果 / 错误。不认识、不完整的帧回 null（丢掉，不当错误）。
 * final 只看「最后一包」标志：全量模式下前面说完的句子一直带着 definite，拿它判「最终」
 * 会让之后每一帧都算最终。
 */
export function parseServerFrame(data: Uint8Array): ServerMessage | null {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.length < 4) return null;
  const headerBytes = ((buffer[0] ?? 0) & 0x0f) * 4;
  const type = (buffer[1] ?? 0) >> 4;
  const flags = (buffer[1] ?? 0) & 0x0f;
  const serialization = (buffer[2] ?? 0) >> 4;
  const compression = (buffer[2] ?? 0) & 0x0f;
  let offset = headerBytes + ((flags & FLAG_HAS_SEQUENCE) !== 0 ? 4 : 0);

  if (type === TYPE_SERVER_ERROR) {
    if (buffer.length < offset + 8) return null;
    const code = buffer.readUInt32BE(offset);
    const length = buffer.readUInt32BE(offset + 4);
    return { kind: "error", code, message: buffer.subarray(offset + 8, offset + 8 + length).toString("utf8") };
  }
  if (type !== TYPE_FULL_SERVER_RESPONSE || serialization !== SERIALIZE_JSON || buffer.length < offset + 4) return null;
  const length = buffer.readUInt32BE(offset);
  offset += 4;
  let payload = buffer.subarray(offset, offset + length);
  if (compression === COMPRESS_GZIP) payload = gunzipSync(payload);
  let body: unknown;
  try {
    body = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  const result = (body as { result?: unknown } | null)?.result;
  // 结果偶尔是候选数组：取第一个（全量模式下它就是当前最可信的那一版），不拼接
  const first = (Array.isArray(result) ? result[0] : result) as { text?: unknown; utterances?: unknown } | undefined;
  const utterances = Array.isArray(first?.utterances) ? (first.utterances as Utterance[]) : [];
  const text =
    typeof first?.text === "string"
      ? first.text
      : utterances.map((item) => (typeof item.text === "string" ? item.text : "")).join("");
  return { kind: "result", text, final: (flags & FLAG_LAST) !== 0 };
}
