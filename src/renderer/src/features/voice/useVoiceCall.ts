/**
 * 编排对话页的语音通话：麦克风 → 流式听写 → 一句话说完自动发成用户消息 → agent 照常跑一轮 →
 * 回答按句送 ElevenLabs 合成 → 逐段播放 → 回到聆听。每一句都是真实的用户消息、每一段回答都是
 * 真实的智能体回答，聊完的内容就是这条对话的聊天记录——通话自己不存第二份文字。
 *
 * 状态怎么走由 call-machine.ts 决定（纯函数、有测试）；这里只执行它给的副作用：开关识别连接、
 * 计停顿、发消息、合成与播放、录音。
 *
 * 资源：一次通话占一路麦克风（getUserMedia 轨道 + AudioContext）、至多一条识别连接、一个播放队列、
 * 两个计时器。挂断（含出错、切会话、卸载）一律走 release，全部放掉；迟到的回调看 live 不是当前
 * 这次就什么都不做。
 *
 * 录音（便宜所以做了）：你这边的麦克风拼成 mic.wav，它播的每一段存 reply-NNN.mp3，外加 manifest.json，
 * 都写进这条会话工作台的 calls/<开始时间>/，不存别处。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { DICTATION_SAMPLE_RATE, type DictationProvider, type VoiceFailure } from "@shared/voice";
import { joinSpoken } from "./dictation-text.ts";
import { PcmChunker, toPcm16 } from "./pcm.ts";
import { CALL_TIMING, initialCallState, reduceCall, type CallEffect, type CallEvent, type CallPhase, type CallState } from "./call-machine.ts";
import { AnswerReader, answerTextAfter, findAskedIndex, type SpokenItem } from "./speech-text.ts";
import { playSpeech, type SpeechPlayback } from "./speech-playback.ts";
import { encodeWav } from "./wav.ts";

/** 说给用户的问题 */
export type CallProblem =
  /** 开始前的检查：缺哪样配置 */
  | { kind: "missing"; dictation: boolean; speech: boolean }
  | { kind: "mic-denied" }
  | { kind: "mic-unavailable" }
  /** 听写连不上 / 断了（通话随之挂断） */
  | ({ kind: "dictation"; provider: DictationProvider } & VoiceFailure)
  /** 某一段合成失败（不挂断：字已经在对话里，接着往下走） */
  | ({ kind: "speech" } & VoiceFailure)
  | { kind: "playback" };

export interface VoiceCall {
  /** null = 没在通话 */
  phase: CallPhase | null;
  muted: boolean;
  /** 麦克风电平 0..1（约 10 次 / 秒刷新） */
  level: number;
  /** 已通话秒数 */
  elapsed: number;
  /** 这一句到目前为止听到的 */
  heard: string;
  problem: CallProblem | null;
  start: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  clearProblem: () => void;
}

interface ManifestEntry {
  at: string;
  kind: "user" | "reply";
  text: string;
  file?: string;
}

interface Live {
  callId: string;
  sessionId: string;
  startedAt: number;
  state: CallState;
  stream: MediaStream | null;
  context: AudioContext | null;
  chunker: PcmChunker;
  /** 当前识别连接 */
  dictationId: string;
  dictationConnected: boolean;
  /** 连上之前的音频 */
  queue: ArrayBuffer[];
  /** 前几条连接（停顿后服务端收尾、自动重连）已固定的文字 + 当前连接的全量 */
  committed: string;
  current: string;
  provider: DictationProvider;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** 它在说时你的声音持续了多久（打断判定） */
  bargeMs: number;
  /** 回答的读取位置（每发一句换新的） */
  reader: AnswerReader;
  /** 发出那一刻对话的最后一条记录：锚点只能在它后面 */
  baselineId: string | null;
  /** 发出后见过 agent 在跑：之后回到空闲才算这一轮完 */
  sawBusy: boolean;
  turnDoneSent: boolean;
  /** 播放队列：每段一个合成中的 promise，按顺序播 */
  speech: { text: string; result: ReturnType<typeof api.voice.speechSynthesize> }[];
  /** 停播时 +1：在途的合成与播放看到代数变了就作废 */
  speechGeneration: number;
  playing: SpeechPlayback | null;
  draining: boolean;
  replyCount: number;
  recorded: Int16Array[];
  recordedSamples: number;
  manifest: ManifestEntry[];
  unsubscribe: () => void;
}

/** 通话目录名：本地时间到秒，`20261124-021530` */
function callIdOf(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

function micProblem(cause: unknown): CallProblem {
  const name = cause instanceof DOMException ? cause.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? { kind: "mic-denied" } : { kind: "mic-unavailable" };
}

export function useVoiceCall(input: {
  /** 绑定的这条对话；null = 没打开对话（不能开始通话） */
  sessionId: string | null;
  transcript: readonly SpokenItem[];
  /** 这条对话的运行态 */
  turnPhase: "idle" | "turn" | "compaction";
  sendText: (text: string) => void;
}): VoiceCall {
  const [phase, setPhase] = useState<CallPhase | null>(null);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState<CallProblem | null>(null);
  const liveRef = useRef<Live | null>(null);
  const levelRef = useRef(0);
  const mutedRef = useRef(false);
  const sendTextRef = useRef(input.sendText);
  const transcriptRef = useRef(input.transcript);
  useLayoutEffect(() => {
    sendTextRef.current = input.sendText;
    transcriptRef.current = input.transcript;
  });

  /** 状态机的一拍：先更新状态，再执行副作用（副作用里可能再派发下一拍） */
  const dispatchRef = useRef<(live: Live, event: CallEvent) => void>(() => undefined);

  const clearSilence = (live: Live): void => {
    if (live.silenceTimer !== null) clearTimeout(live.silenceTimer);
    live.silenceTimer = null;
  };

  const stopSpeech = (live: Live): void => {
    live.speechGeneration += 1;
    live.speech = [];
    live.playing?.stop();
    live.playing = null;
  };

  const save = (live: Live, name: string, data: Uint8Array | string): void => {
    void api.voice.callSave({ sessionId: live.sessionId, callId: live.callId, name, data }).catch(() => undefined);
  };

  /** 挂断后的收尾：放掉一切，录音落盘 */
  const release = useCallback((live: Live) => {
    if (liveRef.current === live) liveRef.current = null;
    clearSilence(live);
    stopSpeech(live);
    live.unsubscribe();
    if (live.dictationId !== "") void api.voice.dictationCancel(live.dictationId).catch(() => undefined);
    for (const track of live.stream?.getTracks() ?? []) track.stop();
    live.stream = null;
    void live.context?.close().catch(() => undefined);
    live.context = null;
    levelRef.current = 0;
    setPhase(null);
    setLevel(0);
    setHeard("");
    // 一句话都没说过、什么都没播的通话不留空目录
    if (live.recordedSamples > 0 || live.manifest.length > 0) {
      if (live.recordedSamples > 0) save(live, "mic.wav", encodeWav(live.recorded, DICTATION_SAMPLE_RATE));
      save(
        live,
        "manifest.json",
        JSON.stringify(
          {
            callId: live.callId,
            sessionId: live.sessionId,
            startedAt: new Date(live.startedAt).toISOString(),
            endedAt: new Date().toISOString(),
            mic: live.recordedSamples > 0 ? "mic.wav" : null,
            entries: live.manifest,
          },
          null,
          2,
        ),
      );
    }
    live.recorded = [];
  }, []);

  /** 出了挂断级的问题：说出来，然后挂断 */
  const fail = useCallback(
    (live: Live, next: CallProblem) => {
      if (liveRef.current !== live) return;
      setProblem(next);
      dispatchRef.current(live, { type: "hangUp" });
    },
    [],
  );

  const sendAudio = (live: Live, chunk: ArrayBuffer): void => {
    if (live.dictationConnected) api.voice.dictationAudio(live.dictationId, chunk);
    else {
      live.queue.push(chunk);
      if (live.queue.length > 50) live.queue.shift();
    }
  };

  const openDictation = useCallback(
    (live: Live, keepText: boolean) => {
      const dictationId = crypto.randomUUID();
      live.dictationId = dictationId;
      live.dictationConnected = false;
      live.queue = [];
      if (!keepText) {
        live.committed = "";
        live.current = "";
      }
      void api.voice
        .dictationStart(dictationId)
        .then((result) => {
          if (liveRef.current !== live || live.dictationId !== dictationId) {
            if (result.ok) void api.voice.dictationCancel(dictationId).catch(() => undefined);
            return;
          }
          if (!result.ok) {
            fail(live, { kind: "dictation", provider: live.provider, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) });
            return;
          }
          live.dictationConnected = true;
          for (const chunk of live.queue) api.voice.dictationAudio(dictationId, chunk);
          live.queue = [];
        })
        .catch(() => fail(live, { kind: "dictation", provider: live.provider, reason: "network" }));
    },
    [fail],
  );

  /** 按顺序把队列里的段合成好的播出来；一段结束派发 spoken */
  const drain = useCallback((live: Live) => {
    if (live.draining) return;
    live.draining = true;
    const generation = live.speechGeneration;
    const step = async (): Promise<void> => {
      while (liveRef.current === live && live.speechGeneration === generation && live.speech.length > 0) {
        const item = live.speech[0];
        if (item === undefined) break;
        const result = await item.result.catch((): Awaited<typeof item.result> => ({ ok: false, reason: "network" }));
        if (liveRef.current !== live || live.speechGeneration !== generation) break;
        live.speech.shift();
        if (!result.ok) {
          setProblem({ kind: "speech", reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) });
          dispatchRef.current(live, { type: "spoken" });
          continue;
        }
        live.replyCount += 1;
        const file = `reply-${String(live.replyCount).padStart(3, "0")}.mp3`;
        save(live, file, result.audio);
        live.manifest.push({ at: new Date().toISOString(), kind: "reply", text: item.text, file });
        const playback = playSpeech(result.audio);
        live.playing = playback;
        const end = await playback.done;
        if (live.playing === playback) live.playing = null;
        if (liveRef.current !== live || live.speechGeneration !== generation) break;
        if (end === "failed") setProblem({ kind: "playback" });
        dispatchRef.current(live, { type: "spoken" });
      }
    };
    void step().finally(() => {
      live.draining = false;
      // 停播（打断）后又来了新的段：用新的代数接着播
      if (liveRef.current === live && live.speech.length > 0 && live.speechGeneration !== generation) drain(live);
    });
  }, []);

  const runEffect = useCallback(
    (live: Live, effect: CallEffect) => {
      switch (effect.type) {
        case "openDictation":
          clearSilence(live);
          setHeard("");
          openDictation(live, false);
          return;
        case "armSilence":
          clearSilence(live);
          live.silenceTimer = setTimeout(() => {
            live.silenceTimer = null;
            dispatchRef.current(live, { type: "silence" });
          }, CALL_TIMING.endOfUtteranceMs);
          return;
        case "finishDictation": {
          clearSilence(live);
          const rest = live.chunker.flush();
          if (rest !== null) sendAudio(live, rest);
          const dictationId = live.dictationId;
          const finish = live.dictationConnected
            ? api.voice.dictationStop(dictationId).catch(() => undefined)
            : Promise.resolve();
          void finish.then(() => {
            if (liveRef.current !== live) return;
            void api.voice.dictationCancel(dictationId).catch(() => undefined);
            if (live.dictationId === dictationId) live.dictationId = "";
            dispatchRef.current(live, { type: "final", text: joinSpoken(live.committed, live.current) });
          });
          return;
        }
        case "send":
          live.reader = new AnswerReader();
          live.baselineId = transcriptRef.current.at(-1)?.id ?? null;
          live.sawBusy = false;
          live.turnDoneSent = false;
          live.manifest.push({ at: new Date().toISOString(), kind: "user", text: effect.text });
          sendTextRef.current(effect.text);
          return;
        case "stopSpeech":
          stopSpeech(live);
          return;
        case "release":
          release(live);
          return;
      }
    },
    [openDictation, release],
  );

  dispatchRef.current = (live: Live, event: CallEvent) => {
    if (liveRef.current !== live && event.type !== "hangUp") return;
    const { state, effects } = reduceCall(live.state, event);
    live.state = state;
    if (state.phase !== "ended") setPhase(state.phase);
    if (event.type === "transcript") setHeard(state.heard);
    for (const effect of effects) runEffect(live, effect);
  };

  const startCapture = useCallback(async (live: Live) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (liveRef.current !== live) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    live.stream = stream;
    const context = new AudioContext();
    live.context = context;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (liveRef.current !== live) return;
      const samples = event.inputBuffer.getChannelData(0);
      const frameMs = (samples.length / context.sampleRate) * 1000;
      if (mutedRef.current) {
        levelRef.current = 0;
        live.bargeMs = 0;
        return;
      }
      const loudness = rms(samples);
      levelRef.current = loudness;
      const pcm = toPcm16(samples, context.sampleRate);
      if (live.recordedSamples < CALL_TIMING.maxRecordSeconds * DICTATION_SAMPLE_RATE) {
        live.recorded.push(pcm);
        live.recordedSamples += pcm.length;
      }
      const phaseNow = live.state.phase;
      if (phaseNow === "speaking") {
        live.bargeMs = loudness > CALL_TIMING.bargeInLevel ? live.bargeMs + frameMs : 0;
        if (live.bargeMs >= CALL_TIMING.bargeInMs) {
          live.bargeMs = 0;
          dispatchRef.current(live, { type: "bargeIn" });
        }
      } else live.bargeMs = 0;
      const chunks = live.chunker.push(pcm);
      // 只有在听的时候才往识别连接里送；在想 / 在说时的声音只录不送
      if (live.state.phase === "listening" && live.dictationId !== "") for (const chunk of chunks) sendAudio(live, chunk);
      if (loudness > CALL_TIMING.speechLevel) dispatchRef.current(live, { type: "voice" });
    };
    source.connect(processor);
    processor.connect(context.destination);
    await context.resume();
  }, []);

  const start = useCallback(async () => {
    if (liveRef.current !== null || input.sessionId === null) return;
    const sessionId = input.sessionId;
    setProblem(null);
    // 先看配齐了没（没配齐不去碰麦克风——不为一次注定失败的通话弹系统授权框）
    const [selection, speech] = await Promise.all([
      api.voice.dictationSelection().catch(() => null),
      api.voice.elevenlabsGet().catch(() => null),
    ]);
    if (liveRef.current !== null) return;
    const dictationReady = selection !== null && selection.configured;
    const speechReady = speech !== null && speech.apiKeyMasked !== null;
    if (!dictationReady || !speechReady) {
      setProblem({ kind: "missing", dictation: !dictationReady, speech: !speechReady });
      return;
    }
    const now = new Date();
    const live: Live = {
      callId: callIdOf(now),
      sessionId,
      startedAt: now.getTime(),
      state: initialCallState(),
      stream: null,
      context: null,
      chunker: new PcmChunker(),
      dictationId: "",
      dictationConnected: false,
      queue: [],
      committed: "",
      current: "",
      provider: selection.provider,
      silenceTimer: null,
      bargeMs: 0,
      reader: new AnswerReader(),
      baselineId: null,
      sawBusy: false,
      turnDoneSent: false,
      speech: [],
      speechGeneration: 0,
      playing: null,
      draining: false,
      replyCount: 0,
      recorded: [],
      recordedSamples: 0,
      manifest: [],
      unsubscribe: () => undefined,
    };
    liveRef.current = live;
    mutedRef.current = false;
    setMuted(false);
    setElapsed(0);
    setPhase("connecting");
    live.unsubscribe = api.voice.onDictationEvent((event) => {
      if (liveRef.current !== live || event.sessionId !== live.dictationId) return;
      if (event.kind === "transcript") {
        live.current = event.text;
        dispatchRef.current(live, { type: "transcript", text: joinSpoken(live.committed, live.current) });
        return;
      }
      if (event.kind === "ended") {
        // 还在听：停顿太久服务端收尾，固定已识别的、接着听（同听写）；收尾中的由 finishDictation 接
        if (live.state.phase !== "listening") return;
        live.committed = joinSpoken(live.committed, live.current);
        live.current = "";
        openDictation(live, true);
        return;
      }
      fail(live, { kind: "dictation", provider: live.provider, reason: event.reason, ...(event.detail === undefined ? {} : { detail: event.detail }) });
    });
    try {
      await startCapture(live);
    } catch (cause) {
      fail(live, micProblem(cause));
      return;
    }
    dispatchRef.current(live, { type: "connected" });
  }, [fail, input.sessionId, openDictation, startCapture]);

  const hangUp = useCallback(() => {
    const live = liveRef.current;
    if (live !== null) dispatchRef.current(live, { type: "hangUp" });
  }, []);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
  }, []);

  // 回答跟着对话长：找到这句的锚点，把新长出的完整句子送去合成；这一轮跑完再把尾巴送掉
  useEffect(() => {
    const live = liveRef.current;
    if (live === null || !live.state.sent || live.state.asked === null) return;
    if (input.turnPhase !== "idle") live.sawBusy = true;
    const anchor = findAskedIndex(input.transcript, live.state.asked, live.baselineId);
    if (anchor < 0) return;
    const after = input.transcript.slice(anchor + 1);
    // 很快的一轮可能在我们看到「在跑」之前就答完了：锚点后有已落定的回答也算
    const settled = after.some((item) => item.role === "assistant") && input.turnPhase === "idle";
    const done = input.turnPhase === "idle" && (live.sawBusy || settled);
    const sentences = live.reader.next(answerTextAfter(input.transcript, anchor), done);
    if (sentences.length > 0) {
      for (const text of sentences) live.speech.push({ text, result: api.voice.speechSynthesize(text) });
      dispatchRef.current(live, { type: "speech", count: sentences.length });
      drain(live);
    }
    if (done && !live.turnDoneSent) {
      live.turnDoneSent = true;
      dispatchRef.current(live, { type: "turnDone" });
    }
  }, [input.transcript, input.turnPhase, drain]);

  // 通话中：电平约 10 次 / 秒、时长每秒刷新（不在音频回调里 setState，那是每 85 ms 一次）
  useEffect(() => {
    if (phase === null) return;
    const meter = setInterval(() => setLevel(levelRef.current), 100);
    const clock = setInterval(() => {
      const live = liveRef.current;
      if (live !== null) setElapsed(Math.floor((Date.now() - live.startedAt) / 1000));
    }, 1000);
    return () => {
      clearInterval(meter);
      clearInterval(clock);
    };
  }, [phase === null]);

  // 切到别的会话：通话绑定的是开始时那条，自动挂断
  useEffect(() => {
    const live = liveRef.current;
    if (live !== null && input.sessionId !== live.sessionId) dispatchRef.current(live, { type: "hangUp" });
  }, [input.sessionId]);

  // 卸载（关窗、离开对话页）：挂断
  useEffect(
    () => () => {
      const live = liveRef.current;
      if (live !== null) dispatchRef.current(live, { type: "hangUp" });
    },
    [],
  );

  return {
    phase,
    muted,
    level,
    elapsed,
    heard,
    problem,
    start: () => void start(),
    hangUp,
    toggleMute,
    clearProblem: () => setProblem(null),
  };
}
