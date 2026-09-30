/**
 * 语音的 IPC —— 四层契约的第 2 层。契约在 shared/voice.ts（豆包凭证三件 + 听写五件）。
 * 入参都是 renderer 给的：逐个校验类型，不认识的当没给。
 */
import { ipcMain, type WebContents } from "electron";
import {
  voiceChannels,
  type DictationEvent,
  type DoubaoVoiceConfig,
  type DoubaoVoiceInput,
  type VoiceResult,
} from "../../shared/voice.ts";
import { createDoubaoProtocol } from "./doubao-protocol.ts";
import type { DictationSessions } from "./dictation.ts";
import type { VoiceStore } from "./store.ts";

/** sessionId 由 renderer 铸（randomUUID）：只收像样的短串 */
function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 64;
}

function doubaoInput(value: unknown): DoubaoVoiceInput | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record["appId"] !== "string" || typeof record["resourceId"] !== "string") return null;
  const token = record["accessToken"];
  return {
    appId: record["appId"],
    resourceId: record["resourceId"],
    ...(typeof token === "string" ? { accessToken: token } : {}),
  };
}

/** ipcRenderer.send 过来的二进制：可能是 ArrayBuffer，也可能是某种 view（结构化克隆的结果随版本变） */
function pcmBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export function registerVoiceIpc(store: VoiceStore, dictation: DictationSessions): void {
  // ── 豆包凭证 ──
  ipcMain.handle(voiceChannels.voiceDoubaoGet, (): Promise<DoubaoVoiceConfig> => store.doubaoConfig());

  ipcMain.handle(voiceChannels.voiceDoubaoSave, async (_event, raw: unknown): Promise<DoubaoVoiceConfig> => {
    const input = doubaoInput(raw);
    if (input === null) throw new Error("invalid Doubao voice config");
    return store.saveDoubao(input);
  });

  ipcMain.handle(voiceChannels.voiceDoubaoTest, async (_event, raw: unknown): Promise<VoiceResult> => {
    const input = doubaoInput(raw);
    const credentials = input === null ? null : await store.doubaoCredentialsFor(input);
    if (credentials === null) return { ok: false, reason: "not-configured" };
    return dictation.test(createDoubaoProtocol(credentials));
  });

  // ── 听写（现在只有豆包一家；第二家接入时这里按「听写用哪家」分派）──

  /** 已经挂过 destroyed 监听的窗口：一个窗口只挂一次 */
  const watched = new Set<number>();
  const watch = (sender: WebContents): void => {
    if (watched.has(sender.id)) return;
    watched.add(sender.id);
    const owner = sender.id;
    sender.once("destroyed", () => {
      watched.delete(owner);
      dictation.cancelOwner(owner);
    });
  };

  ipcMain.handle(voiceChannels.voiceDictationStart, async (event, sessionId: unknown): Promise<VoiceResult> => {
    if (!isSessionId(sessionId)) return { ok: false, reason: "not-configured" };
    const credentials = await store.doubaoCredentials();
    if (credentials === null) return { ok: false, reason: "not-configured" };
    const sender = event.sender;
    watch(sender);
    return dictation.start(sessionId, sender.id, createDoubaoProtocol(credentials), (dictationEvent: DictationEvent) => {
      if (!sender.isDestroyed()) sender.send(voiceChannels.voiceDictationEvent, dictationEvent);
    });
  });

  ipcMain.on(voiceChannels.voiceDictationAudio, (_event, sessionId: unknown, data: unknown) => {
    const pcm = pcmBytes(data);
    if (isSessionId(sessionId) && pcm !== null) dictation.audio(sessionId, pcm);
  });

  ipcMain.handle(voiceChannels.voiceDictationStop, async (_event, sessionId: unknown): Promise<void> => {
    if (isSessionId(sessionId)) await dictation.stop(sessionId);
  });

  ipcMain.handle(voiceChannels.voiceDictationCancel, (_event, sessionId: unknown): void => {
    if (isSessionId(sessionId)) dictation.cancel(sessionId);
  });
}
