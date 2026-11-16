/**
 * 意图系统（实验功能 intent-system）的轮内闸门（kernel-session.ts 开轮时调）。
 * 依赖从外面给（事件出口、确认卡的等待表），本身不持有进程级状态。
 */
import { randomUUID } from "node:crypto";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import {
  applyRecallEvent,
  composeAttachmentPrompt,
  initialRecallCard,
  INTENT_GATE_OFF,
  stagesOfCard,
  type IntentContextFile,
  type IntentRecallTiming,
} from "../shared/intent-recall.ts";
import { intentQuestionText } from "../shared/intent-lab.ts";
import type { IntentRecallRecord } from "../shared/session.ts";
import type { IntentConfirmWaiter } from "./intent-confirm-wait.ts";
import { intentContextPath, writeIntentContextFiles } from "./intent-context-file.ts";
import { runIntentRecall, submitIntentFeedback } from "./intent-recall-client.ts";

export interface IntentGateDeps {
  send: (event: AgentEvent) => void;
  confirm: IntentConfirmWaiter;
}

/**
 * 意图系统（实验功能 intent-system）的轮内闸门：回显之后、调模型之前跑 /recall。
 *
 * 三种结局：
 * - `injection: null` = 这一轮失败 / 取消——
 *   失败时本轮不回答（卡片终态事件已发，phase idle 由 kernel-session 的 startTurn 收尾时发）；
 * - `injection: ""` = 开关关闭（command.intent 缺席，见 INTENT_GATE_OFF）/ 门卫跳过 / 空注入：
 *   照常用原话回答（composeIntentPrompt 直通）；
 * - 其它字符串 = 交给模型的注入块（附件方式时是交付说明）。
 *
 * 事件流（intentRecall）与终态记录（intentRecallRecord）都从这里发出，主进程
 * 落盘 + 广播 + 记 token 账。上下文文件（服务端作者）覆盖写到会话工作台，
 * 写失败只记日志不挡回答。
 */
export async function runIntentGate(
  command: Pick<Extract<AgentCommand, { type: "submit" | "interrupt" }>, "intent" | "directories" | "sessionId" | "text" | "pasted">,
  intentAbort: AbortController,
  turnId: string,
  deps: IntentGateDeps,
): Promise<{ injection: string | null }> {
  const { send } = deps;
  const intent = command.intent;
  // 开关关闭不是失败：空注入、照常回答（见 INTENT_GATE_OFF）
  if (intent === undefined) return INTENT_GATE_OFF;
  const workbench = command.directories?.workbench ?? null;
  const startedAt = Date.now();
  let card = initialRecallCard(turnId, startedAt);
  const outcome = await runIntentRecall(
    {
      baseUrl: intent.baseUrl,
      sessionId: command.sessionId,
      turnId,
      title: intent.title,
      // 召回的提问与 QA 存档同一口径（intentQuestionText）：引用块原样 + 粘贴文本全文
      q: intentQuestionText(command.text, command.pasted ?? []),
      ...(intent.models !== undefined ? { models: intent.models } : {}),
    },
    intentAbort.signal,
    (event) => {
      card = applyRecallEvent(card, event);
      send({ type: "intentRecall", sessionId: command.sessionId, turnId, event });
    },
  );
  const base = {
    role: "intent-recall" as const,
    id: randomUUID(),
    turnId,
    runId: card.runId,
    timestamp: startedAt,
    startedAt,
    scene: card.scene,
    qaTotal: card.accepted?.qaTotal ?? null,
    passed: card.progress?.passed ?? null,
    budgetMs: card.accepted?.budgetMs ?? null,
    peak: card.accepted?.peak ?? false,
    summary: card.review?.summary ?? null,
    selected: card.review?.selected ?? [],
    ask: card.review?.ask ?? [],
    ...(card.review !== null && card.review.askRemaining > 0 ? { askRemaining: card.review.askRemaining } : {}),
    skipped: card.skipped,
    gateWhy: card.gateWhy,
  } satisfies Omit<IntentRecallRecord, "status" | "finishedAt" | "timings" | "error" | "halted" | "stages" | "confirm" | "usage">;
  const sendRecord = (
    status: "done" | "error" | "cancelled",
    extra: {
      finishedAt: number;
      timings: IntentRecallTiming | null;
      error: { stage: string; message: string; retryable: boolean } | null;
      confirm?: IntentRecallRecord["confirm"];
      halted?: { stage: string; done: number | null; total: number | null } | null;
      usage?: IntentRecallRecord["usage"];
    },
  ): void => {
    send({
      type: "intentRecallRecord",
      sessionId: command.sessionId,
      record: {
        ...base,
        status,
        stages: stagesOfCard(card, extra.error?.stage ?? extra.halted?.stage ?? null),
        finishedAt: extra.finishedAt,
        timings: extra.timings,
        error: extra.error,
        halted: extra.halted ?? null,
        ...(extra.confirm === undefined || extra.confirm === null ? {} : { confirm: extra.confirm }),
        ...(extra.usage === undefined ? {} : { usage: extra.usage }),
      },
    });
  };
  if (outcome.kind === "done") {
    let injection = outcome.injection;
    let confirm: IntentRecallRecord["confirm"] = null;
    // 上下文文件（服务端是作者）：覆盖写完再走（几毫秒的本地写，等它换来模型
    // 一定能读到）；写失败只记日志，注入块退回服务端给的原文（拼进原话）
    const applyContext = async (context: IntentContextFile): Promise<void> => {
      if (workbench === null) return;
      try {
        await writeIntentContextFiles(workbench, context);
      } catch (cause) {
        console.error("[intent-recall] 上下文文件写失败（不挡回答）", cause);
        return;
      }
      injection = composeAttachmentPrompt(intentContextPath(workbench), context.notice, context.added);
    };
    if (outcome.context !== null) await applyContext(outcome.context);
    // 门卫跳过：注入块为空串，回答照常用原话，不等、不弹确认
    if (outcome.skipped === "gate") {
      sendRecord("done", { finishedAt: Date.now(), timings: card.timings, error: null });
      return { injection: "" };
    }
    // 回答前确认：needsFeedback 且真有确认项时先不发给模型，把 ask 交给 renderer
    // 弹卡，等应答再 POST /feedback 换最终注入块。等待无超时；取消走 settleIntentAsks
    const ask = card.review?.ask ?? [];
    if (outcome.needsFeedback && ask.length > 0) {
      const decision = await deps.confirm.ask(command.sessionId, outcome.runId, turnId, ask);
      if (decision === "cancelled") {
        sendRecord("cancelled", { finishedAt: Date.now(), timings: card.timings, error: null });
        return { injection: null };
      }
      const feedback = await submitIntentFeedback(intent.baseUrl, outcome.runId, decision.answers, decision.note);
      if (!feedback.ok) {
        // /feedback 失败或 404：不回答，卡片写原因（用户重发即重跑）
        sendRecord("error", {
          finishedAt: Date.now(),
          timings: card.timings,
          error: { stage: "s4", message: feedback.message, retryable: true },
          halted: { stage: "s4", done: null, total: null },
        });
        return { injection: null };
      }
      injection = feedback.injection;
      if (feedback.context !== null) await applyContext(feedback.context);
      confirm = {
        action: decision.action,
        answers: decision.answers,
        note: decision.note,
        edgesWritten: feedback.edgesWritten,
        ...(feedback.promoted === null ? {} : { promoted: feedback.promoted }),
      };
    }
    sendRecord("done", {
      finishedAt: Date.now(),
      timings: card.timings,
      error: null,
      ...(confirm === null ? {} : { confirm }),
      ...(outcome.usage === null ? {} : { usage: outcome.usage }),
    });
    return { injection };
  }
  const cancelled = outcome.kind === "cancelled";
  sendRecord(cancelled ? "cancelled" : "error", {
    finishedAt: Date.now(),
    timings: null,
    error: cancelled
      ? null
      : { stage: outcome.stage, message: outcome.message, retryable: outcome.retryable },
    halted: cancelled
      ? null
      : {
          stage: outcome.stage,
          done: outcome.stage === "s3" ? (card.progress?.done ?? null) : null,
          total: outcome.stage === "s3" ? (card.progress?.total ?? null) : null,
        },
  });
  return { injection: null };
}

