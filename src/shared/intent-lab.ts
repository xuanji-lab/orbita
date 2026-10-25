/**
 * intent-lab HTTP 契约 —— /health 的形状、/recall 的 models 字段、q 的拼装口径。
 *
 * intent-lab 是本机的另一个进程（缺省 http://127.0.0.1:8723，用户自己 `bun run serve`
 * 起，Orbita 不负责拉起它），它在本机编排召回管线、直连模型服务。契约真源在
 * intent-lab 仓（contract 7：/edges、done.usage、review.selected 的 ts/sessionId/source），
 * 这里是它在 IPC 四层第 1 层的投影。
 *
 * 纯模块：类型 + /health 的兼容解析 + 意图口径的 q，不 import electron。
 */
import { composePromptText, splitUserTextBlocks } from "./prompt-attachments.ts";
import { parseChannelPrompt } from "./channel.ts";
import { isClosingScanText } from "./wrapup-scan.ts";
import type { SessionRecord } from "./session.ts";

/**
 * 意图口径的 q（召回提问、/ingest、历史切 QA 三处共用，2026-10-09 用户裁决：
 * 「引用不能剥掉。粘贴的长文本也不能不要。」）：
 * - 引用块原样保留在原话里（与发给模型的正文一致——被引用的上下文正是意图的一部分）；
 * - 粘贴文本块按加入顺序接在原话后面、全文不截断（与发给模型同形：composePromptText
 *   的 `<pasted-text>` 标签，多段依次）；
 * - 附件（图片 / 文件引用清单）不进 q——路径与图不是用户说的话。
 */
export function intentQuestionText(text: string, pasted: readonly string[]): string {
  return composePromptText(text, pasted, []);
}

/* ---------------------------------------------------------------- 渠道与模型 */

/** 召回走哪条管线：Proma（trx50 服务端）或 DeepSeek 官方（花用户自己的 key）。 */
export type IntentChannel = "proma" | "deepseek";

export const INTENT_CHANNELS: readonly IntentChannel[] = ["proma", "deepseek"];

/** 缺省渠道（设置页的二选一缺省值）。 */
export const DEFAULT_INTENT_CHANNEL: IntentChannel = "proma";

/** S3 预设（固定方案，不接受任意端点）：intent-lab 的配置里 proma / deepseek 都是整套预设。 */
export type IntentS3Preset = "two-stage" | "b-only" | "deepseek" | "proma";

/** 门卫 / S1 / S4 的模型选择：intent-lab 配置里的端点名。 */
export type IntentModelChoice = string;

/** /recall 请求体的 models 字段（全部可选；不带 = 沿用服务端配置）。 */
export interface IntentRecallModels {
  gate?: IntentModelChoice;
  s1?: IntentModelChoice;
  s4?: IntentModelChoice;
  s3?: IntentS3Preset;
}

/**
 * 按渠道的 /recall models 覆盖（**一处常量，改管线只改这里**）：两条渠道都是
 * 全显式覆盖（intent-lab 本机配置里门卫与 S1 缺省指向别处，不显式指定就走了
 * 旧管线）。s3 用预设名（"proma" / "deepseek"）；可用性看 /health 的 s3Presets。
 */
export const INTENT_MODELS_BY_CHANNEL: Record<IntentChannel, IntentRecallModels> = {
  proma: { gate: "proma", s1: "proma", s4: "proma", s3: "proma" },
  deepseek: { gate: "deepseek", s1: "deepseek", s4: "deepseek", s3: "deepseek" },
};

/** 渠道字符串的解析（设置读取用）：不认识的值当缺省 proma。 */
export function parseIntentChannel(raw: unknown): IntentChannel {
  return raw === "deepseek" ? "deepseek" : "proma";
}

/**
 * 渠道在服务端是否不可用：/health 的 s3Presets 里没有同名的 S3 预设。渠道发
 * /recall 的 models 每个阶段都点名这个预设名，服务端没有就是 400（2026-10-15
 * 联调：Windows 真机在 config 没配 endpoints.deepseek 时整条召回 400）。
 * s3Presets 缺席（旧服务）= 判不了，返回 null，调用方不报警。
 */
export function intentChannelUnavailable(channel: IntentChannel, s3Presets: readonly IntentS3Preset[] | undefined): boolean | null {
  if (s3Presets === undefined) return null;
  return !s3Presets.includes(channel);
}

/* ---------------------------------------------------------------- /health */

/** GET /health 的形状（contract 2–7 同一张脸；7 起只加过事件与 /edges，字段面没动）。 */
export interface IntentHealth {
  /** 7 = 契约 7（/edges、done.usage、selected 的 ts/sessionId/source） */
  contract: number;
  source: "orbita" | "proma";
  qaImported: number;
  qaIngested: number;
  /** 门卫端点（gate: {endpoint, model}）；旧服务没有——缺席 */
  gate?: { endpoint: string; model: string };
  /** S1 端点（与 gate 同形）；旧服务没有——缺席 */
  s1?: { endpoint: string; model: string };
  /** S4 端点（与 gate 同形）；缺席 = S4 跟 main */
  s4?: { endpoint: string; model: string };
  /** 当前配置下能跑的 S3 预设；旧服务没有——缺席（空数组语义由消费者补） */
  s3Presets?: IntentS3Preset[];
  /** 配置里填全的命名端点（只有名字与 model，不含 apiKey） */
  endpoints?: Record<string, { model: string }>;
  ok: boolean;
  qaVisible: number;
  swarm: { endpoint: string; model: string };
  main: { model: string };
  budgetMs: number;
  peak: boolean;
}

/**
 * /health 的兼容解析：contract 2–7 都认，逐字段校验；坏形状返回 null
 * （调用方按「连不上」处理——探活语义下畸形等于不可用，不猜）。
 */
export function parseIntentHealth(raw: unknown): IntentHealth | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const num = (key: string): number | null =>
    typeof value[key] === "number" && Number.isFinite(value[key] as number) ? (value[key] as number) : null;
  const swarm = value["swarm"];
  const main = value["main"];
  if (typeof swarm !== "object" || swarm === null || typeof main !== "object" || main === null) return null;
  const s = swarm as Record<string, unknown>;
  const m = main as Record<string, unknown>;
  const base = {
    ok: value["ok"] === true,
    qaVisible: num("qaVisible") ?? 0,
    swarm: { endpoint: typeof s.endpoint === "string" ? s.endpoint : "", model: typeof s.model === "string" ? s.model : "" },
    main: { model: typeof m.model === "string" ? m.model : "" },
    budgetMs: num("budgetMs") ?? 0,
    peak: value["peak"] === true,
  };
  const contract = num("contract");
  if (contract === null || contract < 2) return null;
  const epField = (key: string): { endpoint: string; model: string } | undefined => {
    const v = value[key];
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Record<string, unknown>;
    return {
      endpoint: typeof r.endpoint === "string" ? r.endpoint : "",
      model: typeof r.model === "string" ? r.model : "",
    };
  };
  const gate = epField("gate");
  const s1 = epField("s1");
  const s4 = epField("s4");
  const s3Presets = value["s3Presets"];
  const endpoints = value["endpoints"];
  return {
    ...base,
    contract,
    source: value["source"] === "proma" ? "proma" : "orbita",
    qaImported: num("qaImported") ?? 0,
    qaIngested: num("qaIngested") ?? 0,
    ...(gate !== undefined ? { gate } : {}),
    ...(s1 !== undefined ? { s1 } : {}),
    ...(s4 !== undefined ? { s4 } : {}),
    ...(Array.isArray(s3Presets)
      ? {
          s3Presets: s3Presets.filter(
            (p): p is IntentS3Preset => p === "two-stage" || p === "b-only" || p === "deepseek" || p === "proma",
          ),
        }
      : {}),
    ...(typeof endpoints === "object" && endpoints !== null && !Array.isArray(endpoints)
      ? {
          endpoints: Object.fromEntries(
            Object.entries(endpoints as Record<string, unknown>)
              .filter(([, v]) => typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).model === "string")
              .map(([k, v]) => [k, { model: String((v as Record<string, unknown>).model) }]),
          ),
        }
      : {}),
  };
}

/* ---------------------------------------------------------------- /ingest 的行 */

/** /ingest 的请求体（一行 QA；去重键 (sessionId, turnId)）。 */
export interface IntentIngestRow {
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  a: string;
  ts: number;
}

/** assistant 终态记录的最后一个非空文字块（trim 后）。 */
function assistantLastText(record: Extract<SessionRecord, { role: "assistant" }>): string | null {
  let last: string | null = null;
  for (const block of record.content) {
    if (block.type === "text" && block.text.trim() !== "") last = block.text.trim();
  }
  return last;
}

/**
 * 一条根会话的转录里，本轮该存档的 QA 行（/ingest 只在轮末发一行，这里是它的
 * 纯推导：q 用意图口径的原话，a 取本轮最后一条 assistant 终态的最后一段文字）。
 * 通道信封（parseChannelPrompt 可解）与收尾扫描的机器提问（isClosingScanText）
 * 不是用户说的话，不切。
 */
export function ingestRowOf(
  sessionId: string,
  turnId: string,
  title: string,
  text: string,
  pasted: readonly string[],
  records: readonly SessionRecord[],
  ts: number,
): IntentIngestRow {
  let answer: string | null = null;
  for (const record of records) {
    if (record.role !== "assistant" || record.status === "streaming") continue;
    const block = assistantLastText(record);
    if (block !== null) answer = block;
  }
  return { sessionId, turnId, title, q: intentQuestionText(text, pasted), a: answer ?? "", ts };
}

/** 转录里有没有「用户亲口说的话」（信封 / 扫描提问不算）——q 为空串的轮不送 /ingest。 */
export function userSpeechIn(text: string): boolean {
  if (parseChannelPrompt(text) !== null) return false;
  if (isClosingScanText(text)) return false;
  return text.trim() !== "";
}
