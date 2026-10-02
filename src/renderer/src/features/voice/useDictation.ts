/**
 * 输入框的听写：麦克风 → PCM → 主进程（→ 设置里选的厂商）→ 识别文字实时写进输入框。
 *
 * 一次听写的完整生命：
 *   开始  先确认凭证填齐（没填齐不去碰麦克风——不为一次注定失败的听写弹系统授权框）；
 *         按光标把输入框切成前后两段（dictation-text.ts），麦克风与连接**同时**起步，
 *         连上之前的音频先排队，连上后补发——开口的第一个字不丢。
 *   听写  服务端每次推这条连接的全量文字，替换前后两段中间那截。说话停顿久了服务端会收尾
 *         （ended）：已识别的固定下来，换一条连接接着听，用户无感。
 *   结束  （再点麦克风 / 回车）关麦克风、补发最后半段、告诉服务端说完了，等最终结果落定。
 *         文字留在输入框里，不自动发送。
 *   取消  （Esc）断开，输入框回到开始听写前的样子。
 *   出错  断开，已识别的文字留着，问题说给用户。
 *
 * 输入框在听写中被别人改了（切了会话，草稿整个换掉）：静默收掉这次听写，不去覆盖别人的字。
 *
 * 采集用 ScriptProcessorNode：已标记废弃但 Chromium 仍完整支持，回调在主线程——每 85 ms
 * 一次小计算，不值得为它另起 AudioWorklet 模块文件。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { api } from "../../api";
import type { DictationProvider, VoiceFailure } from "@shared/voice";
import { composeDictation, joinSpoken, splitAtSelection } from "./dictation-text.ts";
import { PcmChunker, toPcm16 } from "./pcm.ts";

export type DictationPhase = "idle" | "connecting" | "listening" | "finishing";

/** 说给用户的问题（Composer 用文案表翻译，随厂商换名字） */
export type DictationProblem =
  | { kind: "mic-denied" }
  | { kind: "mic-unavailable" }
  | ({ kind: "service"; provider: DictationProvider } & VoiceFailure);

/** 连上之前最多排多少段（约 10 秒）：再多就丢最早的——连这么久还没连上，多半要失败了 */
const QUEUE_LIMIT = 50;

interface Live {
  /** 开始听写前的输入框（取消时恢复） */
  original: string;
  before: string;
  after: string;
  /** 这条听写用的厂商（问题文案里报它的名字；切换设置不影响进行中的连接） */
  provider: DictationProvider;
  /** 前面几条连接已经固定下来的文字 */
  committed: string;
  /** 当前连接到目前为止的全量文字 */
  current: string;
  /** 我们最后一次写进输入框的值：输入框变成别的，就是别人改了 */
  written: string;
  sessionId: string;
  connected: boolean;
  queue: ArrayBuffer[];
  finishing: boolean;
  chunker: PcmChunker;
  stream: MediaStream | null;
  context: AudioContext | null;
  unsubscribe: () => void;
}

export interface Dictation {
  phase: DictationPhase;
  problem: DictationProblem | null;
  /** 进行中这次听写用的厂商（connecting 的状态行报它的名字） */
  provider: DictationProvider | null;
  /** 麦克风按钮：没在听写就开始，在听写就结束 */
  toggle: () => void;
  /** 结束（回车）：文字留下 */
  finish: () => void;
  /** 取消（Esc）：输入框回到开始前 */
  cancel: () => void;
  clearProblem: () => void;
}

function micProblem(cause: unknown): DictationProblem {
  const name = cause instanceof DOMException ? cause.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? { kind: "mic-denied" } : { kind: "mic-unavailable" };
}

export function useDictation(input: {
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): Dictation {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [problem, setProblem] = useState<DictationProblem | null>(null);
  const [provider, setProvider] = useState<DictationProvider | null>(null);
  const liveRef = useRef<Live | null>(null);
  // 回调里要拿最新的 value / onChange：听写跨好几次渲染，闭包里的会过期
  const valueRef = useRef(input.value);
  const onChangeRef = useRef(input.onChange);
  useLayoutEffect(() => {
    valueRef.current = input.value;
    onChangeRef.current = input.onChange;
  });

  const write = useCallback((live: Live) => {
    const text = composeDictation(live.before, joinSpoken(live.committed, live.current), live.after);
    live.written = text;
    onChangeRef.current(text);
  }, []);

  const stopCapture = useCallback((live: Live) => {
    for (const track of live.stream?.getTracks() ?? []) track.stop();
    live.stream = null;
    void live.context?.close().catch(() => undefined);
    live.context = null;
  }, []);

  /** 收掉这次听写（不动输入框）。只对当前这次生效：旧的迟到回调碰不到新的 */
  const release = useCallback(
    (live: Live) => {
      if (liveRef.current !== live) return;
      liveRef.current = null;
      live.unsubscribe();
      stopCapture(live);
      setPhase("idle");
      setProvider(null);
    },
    [stopCapture],
  );

  const fail = useCallback(
    (live: Live, next: DictationProblem) => {
      if (liveRef.current !== live) return;
      void api.voice.dictationCancel(live.sessionId).catch(() => undefined);
      release(live);
      setProblem(next);
    },
    [release],
  );

  const send = useCallback((live: Live, chunk: ArrayBuffer) => {
    if (live.connected) {
      api.voice.dictationAudio(live.sessionId, chunk);
      return;
    }
    live.queue.push(chunk);
    if (live.queue.length > QUEUE_LIMIT) live.queue.shift();
  }, []);

  /** 告诉服务端说完了，等最终结果落定再收掉 */
  const wrapUp = useCallback(
    (live: Live) => {
      void api.voice
        .dictationStop(live.sessionId)
        .catch(() => undefined)
        .finally(() => release(live));
    },
    [release],
  );

  /** 开一条连接（首次或停顿后重连）；连上前的音频排在 queue 里，连上补发 */
  const connect = useCallback(
    (live: Live) => {
      const sessionId = crypto.randomUUID();
      live.sessionId = sessionId;
      live.connected = false;
      void api.voice
        .dictationStart(sessionId)
        .then((result) => {
          if (liveRef.current !== live || live.sessionId !== sessionId) {
            if (result.ok) void api.voice.dictationCancel(sessionId).catch(() => undefined);
            return;
          }
          if (!result.ok) {
            fail(live, { kind: "service", provider: live.provider, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) });
            return;
          }
          live.connected = true;
          for (const chunk of live.queue) api.voice.dictationAudio(sessionId, chunk);
          live.queue = [];
          if (live.finishing) wrapUp(live);
          else setPhase("listening");
        })
        .catch(() => fail(live, { kind: "service", provider: live.provider, reason: "network" }));
    },
    [fail, wrapUp],
  );

  const startCapture = useCallback(
    async (live: Live) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (liveRef.current !== live || live.finishing) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      live.stream = stream;
      const context = new AudioContext();
      live.context = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (liveRef.current !== live || live.finishing) return;
        const pcm = toPcm16(event.inputBuffer.getChannelData(0), context.sampleRate);
        for (const chunk of live.chunker.push(pcm)) send(live, chunk);
      };
      // 接到 destination 回调才会跑；输出缓冲不写，就是静音，不会回放到扬声器
      source.connect(processor);
      processor.connect(context.destination);
      await context.resume();
    },
    [send],
  );

  const start = useCallback(async () => {
    if (liveRef.current !== null) return;
    setProblem(null);
    // 先看选中的那家配齐了没（没配齐不去碰麦克风——不为一次注定失败的听写弹系统授权框）
    const selection = await api.voice.dictationSelection().catch(() => null);
    if (liveRef.current !== null) return;
    if (selection === null || !selection.configured) {
      setProblem({ kind: "service", provider: selection?.provider ?? "doubao", reason: "not-configured" });
      return;
    }
    const textarea = input.textareaRef.current;
    const original = valueRef.current;
    const { before, after } = splitAtSelection(original, textarea?.selectionStart ?? null, textarea?.selectionEnd ?? null);
    const live: Live = {
      original,
      before,
      after,
      provider: selection.provider,
      committed: "",
      current: "",
      written: original,
      sessionId: "",
      connected: false,
      queue: [],
      finishing: false,
      chunker: new PcmChunker(),
      stream: null,
      context: null,
      unsubscribe: () => undefined,
    };
    liveRef.current = live;
    setPhase("connecting");
    setProvider(selection.provider);
    live.unsubscribe = api.voice.onDictationEvent((event) => {
      if (liveRef.current !== live || event.sessionId !== live.sessionId) return;
      if (event.kind === "transcript") {
        live.current = event.text;
        write(live);
        return;
      }
      if (event.kind === "ended") {
        // 说完了（结束中）：wrapUp 那边会收掉；还在听：停顿太久服务端收尾，固定已识别的、接着听
        if (live.finishing) return;
        live.committed = joinSpoken(live.committed, live.current);
        live.current = "";
        connect(live);
        return;
      }
      fail(live, { kind: "service", provider: live.provider, reason: event.reason, ...(event.detail === undefined ? {} : { detail: event.detail }) });
    });
    connect(live);
    startCapture(live).catch((cause: unknown) => fail(live, micProblem(cause)));
  }, [connect, fail, input.textareaRef, startCapture, write]);

  const finish = useCallback(() => {
    const live = liveRef.current;
    if (live === null || live.finishing) return;
    live.finishing = true;
    setPhase("finishing");
    stopCapture(live);
    const rest = live.chunker.flush();
    if (rest !== null) send(live, rest);
    // 还没连上：连上那一刻 connect 看到 finishing 会自己 wrapUp
    if (live.connected) wrapUp(live);
  }, [send, stopCapture, wrapUp]);

  const cancel = useCallback(() => {
    const live = liveRef.current;
    if (live === null) return;
    void api.voice.dictationCancel(live.sessionId).catch(() => undefined);
    release(live);
    onChangeRef.current(live.original);
  }, [release]);

  const toggle = useCallback(() => {
    if (liveRef.current === null) void start();
    else finish();
  }, [finish, start]);

  // 输入框被别人改了（切会话换了草稿）：静默收掉，不覆盖别人的字
  useEffect(() => {
    const live = liveRef.current;
    if (live !== null && input.value !== live.written) {
      void api.voice.dictationCancel(live.sessionId).catch(() => undefined);
      release(live);
    }
  }, [input.value, release]);

  // Esc 取消：焦点可能在麦克风按钮上而不在输入框里，挂在 document 上
  useEffect(() => {
    if (phase === "idle") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      cancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, cancel]);

  // 卸载（关掉这个输入框）：断开、关麦克风，文字不动
  useEffect(
    () => () => {
      const live = liveRef.current;
      if (live === null) return;
      void api.voice.dictationCancel(live.sessionId).catch(() => undefined);
      live.unsubscribe();
      for (const track of live.stream?.getTracks() ?? []) track.stop();
      void live.context?.close().catch(() => undefined);
      liveRef.current = null;
    },
    [],
  );

  return { phase, problem, provider, toggle, finish, cancel, clearProblem: () => setProblem(null) };
}
