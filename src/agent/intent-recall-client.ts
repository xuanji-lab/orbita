/**
 * intent-lab /recall 客户端 —— 跑在 agent utility 进程里，被 runtime 的 submit /
 * interrupt 在「回显之后、调模型之前」await。
 *
 * 只做三件事：POST NDJSON 流式读取（分块边界由 shared 的装配器处理）、
 * 60 秒静默判定（收不到任何一行、含 heartbeat，就断流报错）、把外部的
 * AbortSignal（停止 / 抢跑 / 删会话）翻译成「取消」而不是「失败」。
 *
 * **传输用 node:http / node:https，不用全局 fetch**（2026-09-26 灰屏攻坚裁决）：
 * 真机上 13 分钟的 S3 流里 progress 行全部失踪而心跳照到（终态 record
 * passed=None、静默计时器活着），消去法只剩 utility 进程里 fetch 的流层
 * （undici / Chromium 网络栈打包行为不明）；node:http 是纯 Node 字节流，
 * 不经任何 Chromium 层，行为在本机可直接验证。诊断计数器随行——下次再有
 * 丢行，一行日志就能定位丢在哪层。
 *
 * 纯逻辑（解析 / 静默 / 归约）都在 shared/intent-recall.ts，本文件只做 IO 编排，
 * 测试用 node:http 起真服务盖住网络面。
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { StringDecoder } from "node:string_decoder";
import {
  createNdjsonAssembler,
  createSilenceTimer,
  parseIntentRecallEvent,
  INTENT_FEEDBACK_FAILED,
  INTENT_LAB_SILENT,
  INTENT_LAB_STREAM_ENDED,
  INTENT_LAB_UNREACHABLE,
  type IntentContextFile,
  type IntentRecallStreamEvent,
  type IntentUsageCount,
} from "../shared/intent-recall.ts";
import type { IntentConfirmAnswer } from "../shared/intent-confirm.ts";
import type { IntentRecallModels } from "../shared/intent-lab.ts";

/** 60 秒收不到任何一行（含 heartbeat）即判死：契约的保活节奏是 10 秒一跳。 */
export const RECALL_SILENCE_MS = 60_000;

export interface RecallRunInput {
  baseUrl: string;
  sessionId: string;
  turnId: string;
  title: string;
  q: string;
  /** v3：跳过门卫直接做意图分析（「做一次意图分析」按钮）；缺省 false */
  force?: boolean;
  /** 各环节模型选择（门卫 / S1 / S4 / S3 预设，按渠道的常量表）；缺省不带字段 */
  models?: IntentRecallModels;
}

/**
 * 一轮 recall 的结局。cancelled 与 error 分开——取消（用户按停止 / 抢跑 / 删会话）
 * 不弹错误卡片，卡片定格成「已取消，本轮未回答」。
 */
export type RecallOutcome =
  | {
      kind: "done";
      injection: string;
      needsFeedback: boolean;
      runId: string;
      skipped: "gate" | null;
      gateWhy: string | null;
      /** v3.2：上下文文件全文（旧服务端 / 门卫跳过时为 null——退回简版文件） */
      context: IntentContextFile | null;
      /** v3.3：本次 done 回写的边数；门卫跳过 / 旧服务端为 null */
      edgesWritten: number | null;
      /** 契约 7：token 用量（DeepSeek / Proma 管线，记 7 天账）；服务端没报为 null */
      usage: IntentUsageCount | null;
    }
  | { kind: "error"; stage: "gate" | "s1" | "s3" | "s4" | "config" | "budget"; message: string; retryable: boolean }
  | { kind: "cancelled" };

export async function runIntentRecall(
  input: RecallRunInput,
  signal: AbortSignal,
  onEvent: (event: IntentRecallStreamEvent) => void,
  /** 静默窗口可注入：产品恒 60s（RECALL_SILENCE_MS），测试用真实短计时盖 IO 编排 */
  silenceMs: number = RECALL_SILENCE_MS,
): Promise<RecallOutcome> {
  // —— 流层诊断计数器（灰屏攻坚）：丢行 / 停滞在真机上只发生在这层时，一行日志定位 ——
  const stats = { chunks: 0, bytes: 0, lines: 0, unparsed: 0, firstUnparsed: "" };
  const parsedByType = new Map<string, number>();

  let silent = false;
  let settle: RecallOutcome | null = null;
  let finished = false;
  let resolveRun: (outcome: RecallOutcome) => void = () => {};
  const run = new Promise<RecallOutcome>((resolve) => {
    resolveRun = resolve;
  });

  const summary = (outcome: RecallOutcome): void => {
    const types = [...parsedByType.entries()].map(([k, v]) => `${k}:${v}`).join(",") || "-";
    console.error(
      `[intent-recall] 流结束 outcome=${outcome.kind} chunks=${stats.chunks} bytes=${stats.bytes} lines=${stats.lines} parsed={${types}} unparsed=${stats.unparsed}` +
        (stats.unparsed > 0 ? ` firstUnparsed=${JSON.stringify(stats.firstUnparsed)}` : ""),
    );
  };
  /** 唯一出口：幂等，结掉 promise 前先停表 / 摧毁连接 / 打诊断摘要。 */
  const finish = (outcome: RecallOutcome): void => {
    if (finished) return;
    finished = true;
    silence.dispose();
    signal.removeEventListener("abort", onExternalAbort);
    summary(outcome);
    if (!req.destroyed) void req.destroy();
    resolveRun(outcome);
  };

  const silence = createSilenceTimer(silenceMs, () => {
    silent = true;
    req.destroy(new Error("silent"));
  });
  const onExternalAbort = (): void => {
    req.destroy();
  };

  const feed = createNdjsonAssembler((line) => {
    silence.activity();
    stats.lines += 1;
    const event = parseIntentRecallEvent(line);
    if (event === null) {
      stats.unparsed += 1;
      if (stats.firstUnparsed === "") stats.firstUnparsed = line.slice(0, 160);
      console.error("[intent-recall] 认不出的行（跳过）", line.slice(0, 120));
      return;
    }
    parsedByType.set(event.type, (parsedByType.get(event.type) ?? 0) + 1);
    // 消费者（utility 内的归约 + postMessage 转发）抛错不掐流：下游一次打嗝
    // 不值 14 分钟的召回作废。事件照常继续读，终态判定在下面独立进行。
    try {
      onEvent(event);
    } catch (cause) {
      console.error("[intent-recall] 流事件消费者抛错（忽略，流继续）", cause);
    }
    if (event.type === "done") {
      settle = {
        kind: "done",
        injection: event.injection,
        needsFeedback: event.needsFeedback,
        runId: event.runId,
        skipped: event.skipped ?? null,
        gateWhy: event.gateWhy ?? null,
        context: event.context ?? null,
        edgesWritten: event.edgesWritten ?? null,
        usage: event.usage ?? null,
      };
      req.destroy();
    } else if (event.type === "error") {
      settle = { kind: "error", stage: event.stage, message: event.message, retryable: event.retryable };
      req.destroy();
    }
  });

  const url = new URL(`${input.baseUrl}/recall`);
  const payload = JSON.stringify({
    sessionId: input.sessionId,
    turnId: input.turnId,
    title: input.title,
    q: input.q,
    // v3：请求只带原话（不再附带最近几轮）；force 跳门卫。缺省不带字段
    ...(input.force === true ? { force: true } : {}),
    // v5：各环节模型选择；缺省不带（沿用服务端配置）
    ...(input.models !== undefined ? { models: input.models } : {}),
  });
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const req = transport(
    url,
    { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } },
    (res) => {
      if (res.statusCode !== 200) {
        finish(signal.aborted ? { kind: "cancelled" } : {
          kind: "error",
          stage: "config",
          message: `${INTENT_LAB_UNREACHABLE} (HTTP ${res.statusCode})`,
          retryable: true,
        });
        res.resume(); // 把非 200 的身体放干净再关
        return;
      }
      const decoder = new StringDecoder("utf8");
      res.on("data", (chunk: Buffer) => {
        stats.chunks += 1;
        stats.bytes += chunk.length;
        feed(decoder.write(chunk));
        if (settle !== null) finish(settle);
      });
      // 流自己结束了却没有 done / error 行：半截流当失败，不猜
      res.on("end", () => {
        finish(settle ?? (signal.aborted ? { kind: "cancelled" } : silent ? { kind: "error", stage: "budget", message: INTENT_LAB_SILENT, retryable: true } : { kind: "error", stage: "config", message: INTENT_LAB_STREAM_ENDED, retryable: true }));
      });
      res.on("aborted", () => {
        finish(settle ?? (signal.aborted ? { kind: "cancelled" } : silent ? { kind: "error", stage: "budget", message: INTENT_LAB_SILENT, retryable: true } : { kind: "error", stage: "config", message: INTENT_LAB_STREAM_ENDED, retryable: true }));
      });
      res.on("error", () => {
        finish(settle ?? (signal.aborted ? { kind: "cancelled" } : silent ? { kind: "error", stage: "budget", message: INTENT_LAB_SILENT, retryable: true } : { kind: "error", stage: "config", message: INTENT_LAB_STREAM_ENDED, retryable: true }));
      });
    },
  );
  req.on("error", (cause) => {
    // 连接层失败：外部取消 / 静默拆流优先分诊，剩下才是真连不上
    if (settle !== null) {
      finish(settle);
      return;
    }
    if (signal.aborted) {
      finish({ kind: "cancelled" });
      return;
    }
    if (silent) {
      finish({ kind: "error", stage: "budget", message: INTENT_LAB_SILENT, retryable: true });
      return;
    }
    // 连不上（没起 / 端口不对）是最高频的失败，给一条能照着做的指引
    console.error("[intent-recall] 连接 intent-lab 失败", cause);
    finish({ kind: "error", stage: "config", message: INTENT_LAB_UNREACHABLE, retryable: true });
  });
  if (signal.aborted) {
    finish({ kind: "cancelled" });
  } else {
    signal.addEventListener("abort", onExternalAbort);
  }
  if (!finished) req.end(payload);
  return run;
}

/**
 * 回答前确认的提交（Tier B 第二批）：把用户的表态 POST /feedback，换最终注入块。
 * 契约：{ runId, answers, note? } → { ok, injection, edgesWritten }；runId 不存在或
 * 已过期 → 404 + { error }。失败返回机器码前缀 INTENT_FEEDBACK_FAILED（renderer
 * 翻译成界面语言，detail 原样附上）。
 */
export async function submitIntentFeedback(
  baseUrl: string,
  runId: string,
  answers: IntentConfirmAnswer[],
  note: string,
): Promise<
  | {
      ok: true;
      injection: string;
      edgesWritten: number;
      /** 契约 7 增补：表态提升为入选的条数（可选——旧服务端不给，NaN-safe） */
      promoted: number | null;
      context: IntentContextFile | null;
    }
  | { ok: false; message: string }
> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        answers,
        // note 空串不带字段——契约里 note 是可选的补充，不是必填项
        ...(note === "" ? {} : { note }),
      }),
    });
  } catch (cause) {
    console.error("[intent-recall] 提交确认失败（连不上 intent-lab）", cause);
    return { ok: false, message: `${INTENT_FEEDBACK_FAILED} (intent-lab unreachable)` };
  }
  if (response.status === 404) {
    return { ok: false, message: `${INTENT_FEEDBACK_FAILED} (run expired, HTTP 404)` };
  }
  if (!response.ok) {
    return { ok: false, message: `${INTENT_FEEDBACK_FAILED} (HTTP ${response.status})` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: `${INTENT_FEEDBACK_FAILED} (unparseable reply)` };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: `${INTENT_FEEDBACK_FAILED} (unparseable reply)` };
  }
  const value = body as Record<string, unknown>;
  if (value["ok"] !== true || typeof value["injection"] !== "string" || typeof value["edgesWritten"] !== "number") {
    return { ok: false, message: `${INTENT_FEEDBACK_FAILED} (malformed reply)` };
  }
  // 契约 7：表态提升条数（可选字段，缺失 / 非数 = null）
  const promotedRaw = value["promoted"];
  const promoted = typeof promotedRaw === "number" && Number.isFinite(promotedRaw) ? promotedRaw : null;
  // v3.2：表态后重写过的上下文文件全文（旧服务端没有——null）
  const rawContext = value["context"];
  const context =
    typeof rawContext === "object" && rawContext !== null
      ? (() => {
          const c = rawContext as Record<string, unknown>;
          if (
            typeof c["question"] !== "number" ||
            typeof c["md"] !== "string" ||
            typeof c["jsonl"] !== "string" ||
            typeof c["added"] !== "number" ||
            typeof c["notice"] !== "string"
          ) {
            return null;
          }
          return { question: c["question"], md: c["md"], jsonl: c["jsonl"], added: c["added"], notice: c["notice"] } satisfies IntentContextFile;
        })()
      : null;
  return { ok: true, injection: value["injection"], edgesWritten: value["edgesWritten"], promoted, context };
}
