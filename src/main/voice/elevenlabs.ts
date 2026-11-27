/**
 * ElevenLabs 文本转语音（通话里「它说」的那一半）。直接调 HTTP 接口，不跑 CLI：通话按句合成，
 * 每句起一次 npx 要好几秒，等不起。
 *
 * 接口：POST /v1/text-to-speech/{voice_id}/stream，请求头 `xi-api-key`，正文 `{ text, model_id }`，
 * 返回 mp3 字节流。这里把一段读完再回给 renderer——通话本身已经按句切好，一句的音频不大，
 * 整段回比在 IPC 上再拆流简单，首句的等待由「按句提前送」吃掉。
 *
 * 失败分类同听写（VoiceFailureReason）：401 / 403 = 钥匙不对；别的状态 = rejected（正文原话
 * 截短带回）；fetch 本身抛 = network；超时 = timeout。钥匙只在请求头里出现，不进任何日志与报错。
 */
import { SPEECH_TEXT_LIMIT, type SpeechResult } from "../../shared/voice.ts";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

/** 一句话合成超过这么久就算失败：通话里等更久不如直接说出问题 */
export const SPEECH_TIMEOUT_MS = 20_000;

/** 服务端原话截到这么长（同听写的 DETAIL_LIMIT） */
const DETAIL_LIMIT = 200;

export interface ElevenlabsCredentials {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

/** fetch 的最小形状：测试里注入假的，生产用全局 fetch */
export interface SpeechResponse {
  status: number;
  ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export type SpeechFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<SpeechResponse>;

const defaultFetch: SpeechFetch = (url, init) => fetch(url, init);

/** 请求地址：音色 id 进路径前编码（设置页手填的，不能信它不带斜杠） */
export function speechUrl(voiceId: string, base: string = ELEVENLABS_BASE_URL): string {
  return `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`;
}

export async function synthesizeSpeech(
  credentials: ElevenlabsCredentials,
  text: string,
  options: { fetch?: SpeechFetch; timeoutMs?: number; base?: string } = {},
): Promise<SpeechResult> {
  const spoken = text.trim().slice(0, SPEECH_TEXT_LIMIT);
  if (spoken === "") return { ok: false, reason: "rejected", detail: "empty text" };
  const doFetch = options.fetch ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SPEECH_TIMEOUT_MS);
  try {
    const response = await doFetch(speechUrl(credentials.voiceId, options.base), {
      method: "POST",
      headers: { "xi-api-key": credentials.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: spoken, model_id: credentials.modelId }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim().slice(0, DETAIL_LIMIT);
      const detail = body === "" ? String(response.status) : `${response.status} ${body}`;
      return { ok: false, reason: response.status === 401 || response.status === 403 ? "unauthorized" : "rejected", detail };
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) return { ok: false, reason: "server", detail: "empty audio" };
    return { ok: true, audio, mimeType: "audio/mpeg" };
  } catch {
    return controller.signal.aborted ? { ok: false, reason: "timeout" } : { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}
