/**
 * 麦克风采样 → 听写要的 PCM（16 kHz / 16 bit 小端 / 单声道，shared/voice.ts）。纯函数，
 * 不碰 Web Audio，node --test 直接加载。
 *
 * 降采样用「窗口内取平均」：麦克风多是 48 kHz，每 3 个样本并成 1 个。平均本身就是一道粗的
 * 低通，对语音识别够用——不为它引重采样库。
 */
import { DICTATION_SAMPLE_RATE } from "../../../../shared/voice.ts";

/** 约 200 ms 一段：16000 样本/秒 × 2 字节 × 0.2 秒 */
export const CHUNK_BYTES = (DICTATION_SAMPLE_RATE * 2) / 5;

/** 浮点采样（-1..1）→ 16 bit 整数，顺带降到 16 kHz。输入采样率不高于目标时原样逐个转换 */
export function toPcm16(samples: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate > DICTATION_SAMPLE_RATE ? inputRate / DICTATION_SAMPLE_RATE : 1;
  const length = Math.floor(samples.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += samples[j] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / (to - from)));
    out[i] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return out;
}

/**
 * 攒够一段再发：Web Audio 的回调一次给 4096 个样本（48 kHz 下约 85 ms），攒成约 200 ms 一段，
 * IPC 次数少一半多，也是豆包文档建议的包长。
 */
export class PcmChunker {
  private pending: Uint8Array = new Uint8Array(0);

  /** 放进一批样本，回凑满的整段（可能零段、一段或几段） */
  push(pcm: Int16Array): ArrayBuffer[] {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const merged = new Uint8Array(this.pending.length + bytes.length);
    merged.set(this.pending, 0);
    merged.set(bytes, this.pending.length);
    const chunks: ArrayBuffer[] = [];
    let offset = 0;
    while (merged.length - offset >= CHUNK_BYTES) {
      chunks.push(merged.slice(offset, offset + CHUNK_BYTES).buffer);
      offset += CHUNK_BYTES;
    }
    this.pending = merged.slice(offset);
    return chunks;
  }

  /** 收尾：不满一段的余量也发出去（说完最后半句不能丢）。没有余量回 null */
  flush(): ArrayBuffer | null {
    if (this.pending.length === 0) return null;
    const rest = this.pending.slice().buffer;
    this.pending = new Uint8Array(0);
    return rest;
  }
}
