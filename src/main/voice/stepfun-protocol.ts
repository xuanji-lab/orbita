/**
 * 阶跃星辰流式语音识别的 JSON 线协议（官方文档「流式语音识别（双向流式）」，
 * platform.stepfun.com），实现 dictation.ts 的 DictationProtocol。**一条连接一个实例**——
 * 拼句状态跨消息存在实例里。全是文本消息：出站 session.update / input_audio_buffer.append /
 * input_audio_buffer.commit，入站按 item（一句话）给增量与定稿。
 *
 * stepaudio-2.5-asr-stream 的语义要点（文档 + 需真 key 复核的点见 git log）：
 * - `conversation.item.input_audio_transcription.delta`：**这句话当前的样子 = text + stash**，
 *   每个 delta 都整体替换、不追加。text 只是已经说定的前缀，stash 是还可能被改写的尾巴，
 *   **两者不重叠**——文档说 stash 含在 text 里，2026-10-01 真 key 日志证明不是：短句整句都在
 *   stash 里、text 为空，直到这句定稿才一次性挪进 text。只读 text 的后果是短句全程看不到字、
 *   长句要等前缀陆续定下来才「突然开始流式」，结束时还没定稿的尾巴整个丢掉。
 * - `…completed` 的 transcript 是该 item 的最终文本（full_rerun_on_commit=true 时是二遍
 *   纠错后的），之后这个 item 不再变。
 * - 错误码里的 `max_idle_timeout` 是「空闲超时」：听写的人停下来想，撞上它当**正常结束**
 *   （renderer 会自动重连接着听），不当错误。
 * - server_vad 开着时文档说不需要主动 commit；但「说完了」还是要发一次——让还压在服务端
 *   缓冲里的尾巴尽快定稿。空缓冲的 commit 服务端可能回错误，收尾阶段的错误一律安静结束。
 *
 * 一条连接的全量文字 = 各 item 按出现顺序拼接：定稿的用 transcript、进行中的用最新 delta.text。
 */
import { DICTATION_SAMPLE_RATE } from "../../shared/voice.ts";
import type { DictationProtocol, OutboundFrame, ProtocolEvent } from "./dictation.ts";

export const STEPFUN_ASR_ENDPOINT = "wss://api.stepfun.com/v1/realtime/asr/stream";

/** 推荐的流式识别模型。将废弃的 step-asr-1.1-stream 不接：delta 是增量追加语义，与 2.5 的整体替换不同 */
const STEPFUN_ASR_MODEL = "stepaudio-2.5-asr-stream";

/**
 * 静音多久判一句话完（server_vad 的 silence_duration_ms）。默认 800 太短——一次换气就断句；
 * 也不学豆包 end_window_size 取 5000 那么保守：豆包断句只影响标点位置，这里一句定稿后连接还在、
 * 后续语音开新句接着拼（连接的全量文字不丢），停顿时句子尽快定稿对听写的实时感更重要。取 1200。
 * threshold 不传，用服务端默认。
 */
const SILENCE_DURATION_MS = 1200;

/** 一句话（item）：进行中的 text 是最新 delta，定稿的是 completed 的 transcript */
interface Item {
  id: string;
  text: string;
  done: boolean;
}

/**
 * 阶跃的线协议工厂。state：item 清单（按出现顺序）、是否已进入收尾（发过 commit）、
 * 出站 event_id 序号。
 */
export function createStepfunProtocol(apiKey: string): DictationProtocol {
  const items: Item[] = [];
  const byId = new Map<string, Item>();
  let stopping = false;
  let seq = 0;
  const nextEventId = (): string => `orbita-${(seq += 1)}`;
  const say = (body: Record<string, unknown>): OutboundFrame => ({ kind: "text", data: JSON.stringify(body) });

  /** 第一次见到这个 item 就登记（保持出现顺序——拼接顺序靠它，不靠 completed 的先后） */
  const item = (id: string): Item => {
    const known = byId.get(id);
    if (known !== undefined) return known;
    const fresh: Item = { id, text: "", done: false };
    items.push(fresh);
    byId.set(id, fresh);
    return fresh;
  };
  const fullText = (): string => items.map((entry) => entry.text).join("");
  const allDone = (): boolean => items.every((entry) => entry.done);

  const transcript = (): ProtocolEvent => ({ kind: "transcript", text: fullText(), final: allDone() });
  /** 收尾完成：结果已齐，生命周期模块据此关连接（当正常结束） */
  const settled = (): boolean => stopping && allDone();

  return {
    url: STEPFUN_ASR_ENDPOINT,
    headers: { Authorization: `Bearer ${apiKey}` },
    openFrame: (): OutboundFrame =>
      say({
        event_id: nextEventId(),
        type: "session.update",
        session: {
          audio: {
            input: {
              // 听写统一送 16 kHz / 16 bit / 单声道 PCM（shared/voice.ts），阶跃也收它
              format: { type: "pcm", codec: "pcm_s16le", rate: DICTATION_SAMPLE_RATE, bits: 16, channel: 1 },
              transcription: {
                model: STEPFUN_ASR_MODEL,
                language: "zh",
                // 提交后二遍纠错 + ITN（数字、标点规整），与豆包侧 enable_nonstream / enable_itn 对齐
                full_rerun_on_commit: true,
                enable_itn: true,
              },
              turn_detection: { type: "server_vad", silence_duration_ms: SILENCE_DURATION_MS },
            },
          },
        },
      }),
    audioFrame: (pcm: Uint8Array): OutboundFrame =>
      say({ event_id: nextEventId(), type: "input_audio_buffer.append", audio: Buffer.from(pcm).toString("base64") }),
    stopFrame: (): OutboundFrame => {
      stopping = true;
      return say({ event_id: nextEventId(), type: "input_audio_buffer.commit" });
    },
    inbound: (data: Uint8Array | string): ProtocolEvent[] => {
      let body: unknown;
      try {
        body = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      } catch {
        return [];
      }
      if (body === null || typeof body !== "object") return [];
      const record = body as Record<string, unknown>;
      const type = typeof record["type"] === "string" ? record["type"] : "";
      if (type === "error") {
        const error = record["error"];
        const detail = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const code = typeof detail["code"] === "string" ? detail["code"] : "";
        const message = typeof detail["message"] === "string" ? detail["message"] : "";
        // 空闲超时当正常结束（renderer 自动重连）；收尾阶段的报错（如空缓冲 commit）安静结束
        if (code === "max_idle_timeout" || stopping) return [{ kind: "ended" }];
        return [{ kind: "error", failure: { reason: "server", detail: `${code} ${message}`.trim() } }];
      }
      const itemId = typeof record["item_id"] === "string" ? record["item_id"] : "";
      if (itemId === "") return [];

      // 服务端听到开口就登记这句：它的文字可能好几秒后才到（长句时服务端识别会落后说话十几秒），
      // 早登记，结束时「所有句子都定稿了吗」才不会漏掉它
      if (type === "input_audio_buffer.speech_started") {
        item(itemId);
        return [];
      }
      if (type === "conversation.item.input_audio_transcription.delta") {
        const settledPart = record["text"];
        const tentative = record["stash"];
        if (typeof settledPart !== "string" && typeof tentative !== "string") return [];
        // 整体替换（含纠错），不追加：说定的前缀 + 还会变的尾巴
        item(itemId).text =
          (typeof settledPart === "string" ? settledPart : "") + (typeof tentative === "string" ? tentative : "");
        return [transcript()];
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        const transcriptText = record["transcript"];
        if (typeof transcriptText !== "string") return [];
        const done = item(itemId);
        done.text = transcriptText;
        done.done = true;
        return settled() ? [transcript(), { kind: "ended" }] : [transcript()];
      }
      // commit 的回执：收尾中且没有进行中的句子 = 结果已齐；平时（VAD 自动提交）不用管
      if (type === "input_audio_buffer.committed") {
        return settled() ? [{ kind: "ended" }] : [];
      }
      // session.created / updated、speech_started / stopped、conversation.item.created：不带文字
      return [];
    },
  };
}
