/**
 * 语音契约 —— IPC 四层的第 1 层。
 *
 * 语音是一整套系统（2026-09-29 用户定位）：分**听写**（说话 → 文字进输入框）与**实时对话**
 * （和模型直接语音往来）两块，厂商会有好几家——豆包、阶跃星辰、阿里千问、Boson AI。
 * 这一刀只做「豆包 + 听写」。命名按最终形状起，后来者只做加法：
 *   - 听写的通道是 `voice:dictation-*`，与厂商无关：renderer 只管送 PCM、收文字；
 *     实时对话来了另起 `voice:realtime-*`。
 *   - 厂商凭证的通道带厂商名（`voice:doubao-*`）：各家要填的东西不一样（豆包三样，别家多是
 *     一个 API key），不硬凑成一个通用表单。第二家接入时再加「听写用哪家」的选择——
 *     只有一家时那个选择没有消费者（AGENTS.md：不提前占位）。
 *   - 落盘 `voice.json` 按厂商分键（`{ doubao: {...} }`），加厂商不用迁移。
 *
 * 听写形态：renderer 采麦克风、转成 16 kHz / 16 bit / 单声道 PCM，约 200 ms 一段发给主进程；
 * 主进程连厂商的服务转发，识别结果推回 renderer 写进输入框。连接放在主进程：豆包的鉴权走
 * 自定义请求头，renderer 里的 WebSocket 加不了请求头。
 *
 * 一次听写可能跨好几条连接：说话停顿久了服务端会结束连接（`ended`），用户还在听写时
 * renderer 换一个 sessionId 重连，前面识别出的文字由 renderer 拼接保留。
 *
 * 凭证：豆包的 APP ID 与 Resource ID 明文存 `voice.json`；Access Token 经系统钥匙串加密存
 * `secrets.json`，**永不回到 renderer**——设置页只拿掩码（同 provider 的 API key）。
 *
 * 调用方：设置 › 语音（豆包凭证：读 / 存 / 测试）、输入框的麦克风按钮（听写：开始 / 音频 /
 * 结束 / 取消 / 订阅事件）。
 */

export const voiceChannels = {
  // ── 豆包凭证（设置 › 语音）──
  /** 读豆包凭证（Token 只给掩码） */
  voiceDoubaoGet: "voice:doubao-get",
  /** 存豆包凭证；accessToken 缺席或空串 = 保留已存的那个。回存后的配置 */
  voiceDoubaoSave: "voice:doubao-save",
  /** 用给定凭证试连一次豆包（accessToken 空 = 用已存的）。不落盘 */
  voiceDoubaoTest: "voice:doubao-test",
  // ── 听写（输入框的麦克风按钮；与厂商无关）──
  /** 开一条识别连接（sessionId 由 renderer 铸）。连上才回 ok；不抛，失败原因在结果里 */
  voiceDictationStart: "voice:dictation-start",
  /** renderer → 主进程：一段 PCM（单向，不回执）。连接不在了就静默丢弃 */
  voiceDictationAudio: "voice:dictation-audio",
  /** 说完了：发最后一包，等服务端给出最终结果后收尾。回的时候最终结果已经推过了 */
  voiceDictationStop: "voice:dictation-stop",
  /** 放弃：立刻断开，不等结果。幂等 */
  voiceDictationCancel: "voice:dictation-cancel",
  /** 主进程 → renderer 推送 `DictationEvent` */
  voiceDictationEvent: "voice:dictation-event",
} as const;

export type VoiceChannel = (typeof voiceChannels)[keyof typeof voiceChannels];

/**
 * 听写送给主进程的音频格式：16 kHz、16 bit 小端、单声道 PCM。renderer 采集后就转成它
 * （features/voice/pcm.ts），主进程原样转发——豆包要的就是这个，别家大多也收它。
 */
export const DICTATION_SAMPLE_RATE = 16000;

/** 豆包流式语音识别模型 2.0、按时长计费。1.0 的应用填 volc.bigasr.sauc.duration */
export const DEFAULT_DOUBAO_RESOURCE_ID = "volc.seedasr.sauc.duration";

/** 设置页读到的豆包凭证。Token 只有掩码（前 3 后 4），null = 还没存 */
export interface DoubaoVoiceConfig {
  appId: string;
  resourceId: string;
  tokenMasked: string | null;
}

export interface DoubaoVoiceInput {
  appId: string;
  resourceId: string;
  /** 缺席或空串 = 保留已存的 Token */
  accessToken?: string;
}

/** 三样都齐了才能听写 */
export function isDoubaoConfigured(config: DoubaoVoiceConfig): boolean {
  return config.appId.trim() !== "" && config.resourceId.trim() !== "" && config.tokenMasked !== null;
}

/**
 * 连不上 / 被拒的原因（renderer 用文案表翻成人话）。
 *   not-configured  凭证没填齐
 *   unauthorized    服务端回 401 / 403：凭证不对，或服务没开通
 *   rejected        服务端回了别的 HTTP 状态
 *   network         连不上（DNS、断网、被代理拦）
 *   timeout         连了 10 秒没连上
 *   server          连上之后服务端发来错误（detail 带它的错误码与原文）
 */
export type VoiceFailureReason = "not-configured" | "unauthorized" | "rejected" | "network" | "timeout" | "server";

export interface VoiceFailure {
  reason: VoiceFailureReason;
  /** 服务端的原话（HTTP 状态 + 响应正文、或错误帧的码与消息）。机器事实，原样给人看 */
  detail?: string;
}

export type VoiceResult = { ok: true } | ({ ok: false } & VoiceFailure);

export type DictationEvent =
  /** 这条连接到目前为止识别出的全部文字（服务端每次给全量，不是增量）；final = 服务端说这是最终结果 */
  | { sessionId: string; kind: "transcript"; text: string; final: boolean }
  /** 连接正常结束（说完了，或停顿太久服务端收尾）。还在听写就该重连 */
  | { sessionId: string; kind: "ended" }
  /** 连接出错断开 */
  | ({ sessionId: string; kind: "error" } & VoiceFailure);
