/**
 * 播一段合成好的 mp3（设置页的「试听」与通话里的逐段播放共用）。用 <audio> + blob URL：
 * 解码交给浏览器，停就是 pause；播完、出错、被停三种结局都把 URL 收回，不留 blob。
 */

export type PlaybackEnd = "ended" | "stopped" | "failed";

export interface SpeechPlayback {
  /** 结局落定时 resolve（不 reject） */
  done: Promise<PlaybackEnd>;
  /** 立刻停（打断 / 挂断）。幂等 */
  stop: () => void;
}

export function playSpeech(audio: Uint8Array): SpeechPlayback {
  const url = URL.createObjectURL(new Blob([audio.slice()], { type: "audio/mpeg" }));
  const element = new Audio(url);
  let settle: (end: PlaybackEnd) => void = () => undefined;
  let settled = false;
  const done = new Promise<PlaybackEnd>((resolve) => {
    settle = (end) => {
      if (settled) return;
      settled = true;
      element.onended = null;
      element.onerror = null;
      URL.revokeObjectURL(url);
      resolve(end);
    };
  });
  element.onended = () => settle("ended");
  element.onerror = () => settle("failed");
  element.play().catch(() => settle("failed"));
  return {
    done,
    stop: () => {
      if (settled) return;
      element.pause();
      settle("stopped");
    },
  };
}
