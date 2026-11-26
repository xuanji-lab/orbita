/**
 * 通话录音的「你这边」：把采到的 16 bit 单声道 PCM 段拼成一个 wav（44 字节标准头）。纯函数。
 */
export function encodeWav(chunks: readonly Int16Array[], sampleRate: number): Uint8Array {
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const dataBytes = samples * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return out;
}
