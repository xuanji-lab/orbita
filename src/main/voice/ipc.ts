/**
 * 语音的 IPC —— 四层契约的第 2 层。契约在 shared/voice.ts（听写厂商选择两件、豆包凭证三件、
 * 阶跃凭证三件、听写五件）。入参都是 renderer 给的：逐个校验类型，不认识的当没给。
 */
import { ipcMain, type WebContents } from "electron";
import {
  isDictationProvider,
  voiceChannels,
  type DictationEvent,
  type DictationProvider,
  type DictationSelection,
  type DoubaoVoiceConfig,
  type DoubaoVoiceInput,
  type StepfunVoiceConfig,
  type StepfunVoiceInput,
  type VoiceResult,
} from "../../shared/voice.ts";
import { createDoubaoProtocol } from "./doubao-protocol.ts";
import { createStepfunProtocol } from "./stepfun-protocol.ts";
import type { DictationProtocol, DictationSessions } from "./dictation.ts";
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

function stepfunInput(value: unknown): StepfunVoiceInput | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record["apiKey"] === undefined) return {};
  return typeof record["apiKey"] === "string" ? { apiKey: record["apiKey"] } : null;
}

export function registerVoiceIpc(store: VoiceStore, dictation: DictationSessions): void {
  // ── 听写用哪家 ──
  ipcMain.handle(voiceChannels.voiceDictationSelectionGet, (): Promise<DictationSelection> =>
    store.dictationSelection(),
  );

  ipcMain.handle(voiceChannels.voiceDictationProviderSet, (_event, raw: unknown): Promise<DictationSelection> => {
    if (!isDictationProvider(raw)) throw new Error("invalid dictation provider");
    return store.setDictationProvider(raw);
  });

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

  // ── 阶跃星辰凭证 ──
  ipcMain.handle(voiceChannels.voiceStepfunGet, (): Promise<StepfunVoiceConfig> => store.stepfunConfig());

  ipcMain.handle(voiceChannels.voiceStepfunSave, async (_event, raw: unknown): Promise<StepfunVoiceConfig> => {
    const input = stepfunInput(raw);
    if (input === null) throw new Error("invalid StepFun voice config");
    return store.saveStepfun(input);
  });

  ipcMain.handle(voiceChannels.voiceStepfunTest, async (_event, raw: unknown): Promise<VoiceResult> => {
    const input = stepfunInput(raw);
    const apiKey = input === null ? null : await store.stepfunCredentialsFor(input);
    if (apiKey === null) return { ok: false, reason: "not-configured" };
    return dictation.test(createStepfunProtocol(apiKey));
  });

  // ── 听写（voice:dictation-start 按所选厂商分派线协议）──

  async function protocolFor(provider: DictationProvider): Promise<DictationProtocol | null> {
    if (provider === "stepfun") {
      const apiKey = await store.stepfunApiKey();
      return apiKey === null ? null : createStepfunProtocol(apiKey);
    }
    const credentials = await store.doubaoCredentials();
    return credentials === null ? null : createDoubaoProtocol(credentials);
  }

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
    const protocol = await protocolFor(await store.dictationProvider());
    if (protocol === null) return { ok: false, reason: "not-configured" };
    const sender = event.sender;
    watch(sender);
    return dictation.start(sessionId, sender.id, protocol, (dictationEvent: DictationEvent) => {
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
