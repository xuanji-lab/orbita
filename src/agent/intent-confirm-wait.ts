/**
 * 回答前确认的等待编排（Tier B 第二批）—— runtime 的 pendingPermissions /
 * askPermission / settlePendingPermissions 同款请求-应答，单独成文件只为可测
 * （runtime 本体被 parentPort 守卫钉死在 utility 进程里）。
 *
 * 语义（审核 2026-09-25 第二批裁决）：
 * - **没有超时**：用户可能去泡杯咖啡再回来点（askPermission 同款纪律）；
 * - **不听 abort**：停止 / 抢跑 / 删会话必须显式调 settle，把等待按「取消」结掉，
 *   否则那一轮永远不收尾、running 表的坑永远占着；
 * - 应答按 requestId 校对，陈旧应答（取消后用户才点）丢弃不串台。
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import type { IntentAskView } from "../shared/intent-recall.ts";
import type { IntentConfirmDecision } from "../shared/intent-confirm.ts";

interface Waiting {
  requestId: string;
  resolve: (decision: IntentConfirmDecision | "cancelled") => void;
}

export class IntentConfirmWaiter {
  private readonly pending = new Map<string, Waiting>();
  private readonly send: (event: AgentEvent) => void;

  constructor(send: (event: AgentEvent) => void) {
    this.send = send;
  }

  /** 发请示并挂起等待。key 是 sessionId——一条会话同一时刻最多一张确认卡。 */
  ask(sessionId: string, runId: string, turnId: string, ask: IntentAskView[]): Promise<IntentConfirmDecision | "cancelled"> {
    return new Promise((resolve) => {
      const requestId = `${sessionId}:intent:${randomUUID()}`;
      this.pending.set(sessionId, { requestId, resolve });
      this.send({ type: "intentAsk", sessionId, requestId, runId, turnId, ask });
    });
  }

  /** 应答到达：requestId 对得上才结（陈旧应答丢弃）。返回是否真的结掉了。 */
  answer(requestId: string, decision: IntentConfirmDecision): boolean {
    const sessionId = requestId.split(":intent:")[0] ?? "";
    if (sessionId === "") return false;
    const waiting = this.pending.get(sessionId);
    if (waiting === undefined || waiting.requestId !== requestId) return false;
    this.pending.delete(sessionId);
    waiting.resolve(decision);
    return true;
  }

  /** 停止 / 抢跑 / 删会话：把该会话的等待按「取消」结掉。没有等待是 no-op。 */
  settle(sessionId: string): void {
    const waiting = this.pending.get(sessionId);
    if (waiting === undefined) return;
    this.pending.delete(sessionId);
    waiting.resolve("cancelled");
  }

  /** 等待中的会话数（测试与诊断用）。 */
  get size(): number {
    return this.pending.size;
  }
}
