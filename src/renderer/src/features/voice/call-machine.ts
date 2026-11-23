/**
 * 通话的状态机（纯函数，node --test 直接加载）：一来一回的半双工 + 尽力而为的打断。
 *
 *   connecting ──接通──▶ listening ──停顿──▶ thinking ──回答第一句──▶ speaking
 *        ▲                    ▲   │（说完的话发成一条用户消息）        │
 *        │                    │   └──────听到的是空的──────────────────┘
 *        │                    └───────── 这一轮答完、全部播完 ◀────────┘
 *        │                    └───────── 它在说时你开口（打断）◀───────┘
 *   挂断 / 出错 ──▶ ended（终态，所有资源由 hook 释放）
 *
 * 断句不等服务端的「最终」：豆包只在收到最后一包时才给 final，句中不会给；所以「一句话说完」=
 * 听到了字，且**文字不再变、麦克风也安静**持续 CALL_TIMING.endOfUtteranceMs。到点后 hook 告诉服务端
 * 说完了，拿到最终文字再发。
 *
 * reducer 只决定「下一步是什么」，副作用（开关识别连接、发消息、播放）由返回的 effects 交给
 * useVoiceCall 执行——这样时序能在测试里逐拍走一遍。
 */

/** 通话的时间与阈值常量，集中放这里 */
export const CALL_TIMING = {
  /** 文字不变 + 麦克风安静这么久，算这句话说完了 */
  endOfUtteranceMs: 800,
  /** 麦克风电平（RMS，0..1）高过它算「在说话」 */
  speechLevel: 0.02,
  /** 它在说时你的声音高过它（比 speechLevel 高：扬声器漏进来的回声不该把自己打断）…… */
  bargeInLevel: 0.05,
  /** ……在最近这么长的一段里…… */
  bargeInWindowMs: 700,
  /** ……累计响过这么久，才算你开口打断。不要求「连续」：说话的字与字之间本来就有空隙，
   * 要求连续 350ms 在实测里一次都没触发（2026-11-24 假麦克风） */
  bargeInMs: 300,
  /** 录音最长存这么久（16 kHz 单声道约 1 MB/分钟），超了只录前面这段 */
  maxRecordSeconds: 1800,
} as const;

export type CallPhase = "connecting" | "listening" | "thinking" | "speaking" | "ended";

export interface CallState {
  phase: CallPhase;
  /** 这一句到目前为止听到的（全量） */
  heard: string;
  /** 已经发出去、在等它回答的那句话（thinking / speaking 期间有值） */
  asked: string | null;
  /** 这一轮的回答文字已经全部出来了（agent 一轮跑完） */
  turnDone: boolean;
  /** 这句话已经发成用户消息了（之前是在收尾等最终文字；之后才收回答） */
  sent: boolean;
  /** 还没播完的段数（排队中 + 正在播） */
  pendingSpeech: number;
}

export type CallEvent =
  | { type: "connected" }
  | { type: "transcript"; text: string }
  /** 麦克风这一帧有人声（电平高过 speechLevel） */
  | { type: "voice" }
  /** 停顿计时到点 */
  | { type: "silence" }
  /** 服务端给出这一句的最终文字（hook 在 silence 之后主动收尾拿到的） */
  | { type: "final"; text: string }
  /** 回答里新切出了几段要说的话 */
  | { type: "speech"; count: number }
  /** 一段播完（或合成失败跳过） */
  | { type: "spoken" }
  /** agent 这一轮跑完了 */
  | { type: "turnDone" }
  /** 它在说时你开口了（hook 按 bargeInLevel / bargeInMs 判） */
  | { type: "bargeIn" }
  | { type: "hangUp" };

export type CallEffect =
  /** 开一条新的识别连接（进 listening 时） */
  | { type: "openDictation" }
  /** 重新计停顿 */
  | { type: "armSilence" }
  /** 告诉服务端这句说完了，等最终文字 */
  | { type: "finishDictation" }
  /** 把这句话发成一条用户消息 */
  | { type: "send"; text: string }
  /** 停掉正在播与排队的语音 */
  | { type: "stopSpeech" }
  /** 挂断：释放全部资源 */
  | { type: "release" };

export function initialCallState(): CallState {
  return { phase: "connecting", heard: "", asked: null, sent: false, turnDone: false, pendingSpeech: 0 };
}

const listening = (state: CallState): CallState => ({
  ...state,
  phase: "listening",
  heard: "",
  asked: null,
  sent: false,
  turnDone: false,
  pendingSpeech: 0,
});

/** 一轮回答收尾：答完了且没有要播的 → 回到聆听 */
function settleTurn(state: CallState): { state: CallState; effects: CallEffect[] } {
  if (state.turnDone && state.pendingSpeech === 0) return { state: listening(state), effects: [{ type: "openDictation" }] };
  return { state, effects: [] };
}

export function reduceCall(state: CallState, event: CallEvent): { state: CallState; effects: CallEffect[] } {
  if (state.phase === "ended") return { state, effects: [] };
  if (event.type === "hangUp") return { state: { ...state, phase: "ended" }, effects: [{ type: "stopSpeech" }, { type: "release" }] };

  switch (event.type) {
    case "connected":
      return state.phase === "connecting" ? { state: listening(state), effects: [{ type: "openDictation" }] } : { state, effects: [] };
    case "transcript":
      if (state.phase !== "listening" || event.text === state.heard) return { state, effects: [] };
      return { state: { ...state, heard: event.text }, effects: event.text.trim() === "" ? [] : [{ type: "armSilence" }] };
    case "voice":
      return state.phase === "listening" && state.heard.trim() !== "" ? { state, effects: [{ type: "armSilence" }] } : { state, effects: [] };
    case "silence":
      if (state.phase !== "listening" || state.heard.trim() === "") return { state, effects: [] };
      return { state: { ...state, phase: "thinking", asked: state.heard.trim() }, effects: [{ type: "finishDictation" }] };
    case "final": {
      if (state.phase !== "thinking" || state.sent) return { state, effects: [] };
      const text = event.text.trim() !== "" ? event.text.trim() : (state.asked ?? "");
      // 收尾后什么也没听清：当没说，接着听
      if (text === "") return { state: listening(state), effects: [{ type: "openDictation" }] };
      return { state: { ...state, asked: text, sent: true }, effects: [{ type: "send", text }] };
    }
    case "speech":
      if (!state.sent || event.count <= 0 || (state.phase !== "thinking" && state.phase !== "speaking")) return { state, effects: [] };
      return { state: { ...state, phase: "speaking", pendingSpeech: state.pendingSpeech + event.count }, effects: [] };
    case "spoken": {
      if (state.phase !== "speaking") return { state, effects: [] };
      const pendingSpeech = Math.max(0, state.pendingSpeech - 1);
      // 播完了这一批但回答还没出完：回到「在想」，等下一句
      const next: CallState = { ...state, pendingSpeech, phase: pendingSpeech === 0 && !state.turnDone ? "thinking" : "speaking" };
      return settleTurn(next);
    }
    case "turnDone":
      if (!state.sent || (state.phase !== "thinking" && state.phase !== "speaking")) return { state, effects: [] };
      return settleTurn({ ...state, turnDone: true });
    case "bargeIn":
      // 只停播放、回到聆听；agent 这一轮不停，它写出来的字照样留在对话里，只是不再念
      if (state.phase !== "speaking") return { state, effects: [] };
      return { state: listening(state), effects: [{ type: "stopSpeech" }, { type: "openDictation" }] };
  }
}

/**
 * 打断判定：最近 bargeInWindowMs 里，电平高过 bargeInLevel 的帧累计够 bargeInMs 就算开口。
 * 每帧喂一次（帧长随采样率变，约 85 ms），触发后清零重新计。
 */
export class BargeDetector {
  private frames: { ms: number; loud: boolean }[] = [];

  push(level: number, frameMs: number): boolean {
    this.frames.push({ ms: frameMs, loud: level > CALL_TIMING.bargeInLevel });
    let span = 0;
    let loud = 0;
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame === undefined) break;
      if (span >= CALL_TIMING.bargeInWindowMs) {
        this.frames = this.frames.slice(index + 1);
        break;
      }
      span += frame.ms;
      if (frame.loud) loud += frame.ms;
    }
    if (loud >= CALL_TIMING.bargeInMs) {
      this.reset();
      return true;
    }
    return false;
  }

  reset(): void {
    this.frames = [];
  }
}
