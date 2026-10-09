/**
 * 语音的 contextBridge 面 —— 四层契约的第 3 层。契约在 shared/voice.ts。
 * 密钥只进不出：save 可以带它，get 只回掩码（豆包 Access Token、阶跃 API Key 同一条规矩）。
 */
import { ipcRenderer } from "electron";
import {
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

export const voiceApi = {
  // ── 听写用哪家（设置 › 语音；useDictation 的前置检查）──
  dictationSelection: (): Promise<DictationSelection> => ipcRenderer.invoke(voiceChannels.voiceDictationSelectionGet),
  setDictationProvider: (provider: DictationProvider): Promise<DictationSelection> =>
    ipcRenderer.invoke(voiceChannels.voiceDictationProviderSet, provider),
  // ── 豆包凭证（设置 › 语音）──
  doubaoGet: (): Promise<DoubaoVoiceConfig> => ipcRenderer.invoke(voiceChannels.voiceDoubaoGet),
  doubaoSave: (input: DoubaoVoiceInput): Promise<DoubaoVoiceConfig> =>
    ipcRenderer.invoke(voiceChannels.voiceDoubaoSave, input),
  doubaoTest: (input: DoubaoVoiceInput): Promise<VoiceResult> => ipcRenderer.invoke(voiceChannels.voiceDoubaoTest, input),
  // ── 阶跃星辰凭证（设置 › 语音）──
  stepfunGet: (): Promise<StepfunVoiceConfig> => ipcRenderer.invoke(voiceChannels.voiceStepfunGet),
  stepfunSave: (input: StepfunVoiceInput): Promise<StepfunVoiceConfig> =>
    ipcRenderer.invoke(voiceChannels.voiceStepfunSave, input),
  stepfunTest: (input: StepfunVoiceInput): Promise<VoiceResult> =>
    ipcRenderer.invoke(voiceChannels.voiceStepfunTest, input),
  // ── 听写（输入框的麦克风按钮）──
  dictationStart: (sessionId: string): Promise<VoiceResult> =>
    ipcRenderer.invoke(voiceChannels.voiceDictationStart, sessionId),
  /** 单向：音频一段段往里送，不等回执 */
  dictationAudio: (sessionId: string, pcm: ArrayBuffer): void =>
    ipcRenderer.send(voiceChannels.voiceDictationAudio, sessionId, pcm),
  dictationStop: (sessionId: string): Promise<void> => ipcRenderer.invoke(voiceChannels.voiceDictationStop, sessionId),
  dictationCancel: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(voiceChannels.voiceDictationCancel, sessionId),
  onDictationEvent: (listener: (event: DictationEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: DictationEvent) => listener(payload);
    ipcRenderer.on(voiceChannels.voiceDictationEvent, handler);
    return () => ipcRenderer.removeListener(voiceChannels.voiceDictationEvent, handler);
  },
} as const;
