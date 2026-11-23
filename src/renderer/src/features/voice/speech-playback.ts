/**
 * 播一段合成好的 mp3（设置页的「试听」与通话里的逐段播放共用）。走 Web Audio（decodeAudioData +
 * BufferSource），不用 <audio> + blob URL：页面 CSP 的 default-src 'self' 不放 blob: 媒体，
 * 为播一段语音去放宽 CSP 不划算（2026-11-24 实测 <audio> 播 blob 直接失败）。
 * 播完、出错、被停三种结局都 resolve 一次。
 */

export type PlaybackEnd = "ended" | "stopped" | "failed";

export interface SpeechPlayback {
  /** 结局落定时 resolve（不 reject） */
  done: Promise<PlaybackEnd>;
  /** 立刻停（打断 / 挂断）。幂等 */
  stop: () => void;
}

/** 全页共用一个播放用的 AudioContext：每段新建一个太贵，且 Chromium 对同时存在的个数有上限 */
let shared: AudioContext | null = null;

function playbackContext(): AudioContext {
  if (shared === null || shared.state === "closed") shared = new AudioContext();
  return shared;
}

export function playSpeech(audio: Uint8Array): SpeechPlayback {
  let source: AudioBufferSourceNode | null = null;
  let settled = false;
  let settle: (end: PlaybackEnd) => void = () => undefined;
  const done = new Promise<PlaybackEnd>((resolve) => {
    settle = (end) => {
      if (settled) return;
      settled = true;
      resolve(end);
    };
  });
  const context = playbackContext();
  void context
    .resume()
    .then(() => context.decodeAudioData(audio.slice().buffer))
    .then((buffer) => {
      if (settled) return;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      node.onended = () => settle("ended");
      source = node;
      node.start();
    })
    .catch(() => settle("failed"));
  return {
    done,
    stop: () => {
      if (settled) return;
      settle("stopped");
      try {
        source?.stop();
      } catch {
        // 还没 start 或已经停了：无事可做
      }
    },
  };
}
