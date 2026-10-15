/**
 * 意图系统的回答存档（/ingest）—— 主进程侧的轮次跟踪器。
 *
 * 契约：本轮回答**正常结束**后调 POST /ingest（q = 意图口径原话：引用块原样 +
 * 粘贴文本全文，a = 助手该轮最后一段文字，title = 会话标题）；出错、取消、
 * 未回答的轮不调。失败只记日志，不影响界面（存档是意图系统的养分，不是对话
 * 链路的一环）。
 *
 * 判定「正常结束」的三个信号（都从 agent 事件流来）：
 * 1. submit 带来本轮原话（begin）；
 * 2. 本轮用户回显（progress item_started，role=user）——turnId 从这取；召回轮
 *    也会由 intentRecall 的 done 事件再补一次（同一个 id，幂等）；
 * 3. 至少一条 `status:"complete"` 的 assistant 终态 + `phase idle`——轮落定，
 *    此时若 1、2 都在，才发 /ingest。
 * 会话级召回开关关的轮没有 recall，但回显仍在——照常存档（历史还要攒，只是不做召回）。
 *
 * 纯模块（不 import electron，可被 node --test 直接加载）：HTTP 与配置读取都注入。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { isClosingScanText } from "../../shared/closing-scan.ts";
import { ingestRowOf, userSpeechIn } from "../../shared/intent-lab.ts";
import type { SessionRecord } from "../../shared/session.ts";

interface TurnState {
  /** submit 带来的用户原话（含引用块；存档不剥） */
  text: string;
  /** 随消息发的粘贴文本块（全文不截断，拼进 q） */
  pasted: readonly string[];
  /** 本轮用户回显的 item id（intentRecall done 也会补同一个）；null = 还没回显 */
  turnId: string | null;
  /** 出现过一条 complete 的 assistant 终态 */
  answered: boolean;
}

export interface IngestHttp {
  post(url: string, body: unknown): Promise<void>;
}

export interface IngestDeps {
  http: IngestHttp;
  /** 读一条会话的标题与转录（settling 时取 a 与 title） */
  load: (sessionId: string) => Promise<{ title: string; transcript: readonly SessionRecord[] } | null>;
  /** settle 时现读意图设置；null = 不存档（实验开关可能刚被关掉） */
  readIntent: (sessionId: string) => Promise<{ baseUrl: string } | null>;
}

export class IntentIngestTracker {
  private readonly turns = new Map<string, TurnState>();
  private readonly deps: IngestDeps;

  constructor(deps: IngestDeps) {
    this.deps = deps;
  }

  /** submit / interrupt 发出时记下本轮原话与粘贴块（主进程判过「要存档」才调）。
   *  收尾扫描的机器提问不进意图系统的库：它是仪式不是用户意图。 */
  begin(sessionId: string, text: string, pasted: readonly string[] = []): void {
    if (isClosingScanText(text) || !userSpeechIn(text)) return;
    this.turns.set(sessionId, { text, pasted, turnId: null, answered: false });
  }

  /** 事件流喂进来：盯本轮回显、recall done、assistant 完成、轮落定。 */
  onEvent(event: AgentEvent): void {
    if (event.type === "phase" && event.phase === "turn") {
      // 新一轮开跑：上一轮没走到 settle 就被翻页 = 出错 / 抢跑，重置回答标记
      const current = this.turns.get(event.sessionId);
      if (current !== undefined) current.answered = false;
      return;
    }
    // 本轮第一条用户回显 → turnId（组合文本的第二条回显不覆盖——/ingest 的
    // 去重键认的是用户原话那条）
    if (
      event.type === "progress" &&
      event.progress.type === "item_started" &&
      event.progress.item.role === "user"
    ) {
      const current = this.turns.get(event.sessionId);
      if (current !== undefined && current.turnId === null) current.turnId = event.progress.item.id;
      return;
    }
    if (event.type === "intentRecall" && event.event.type === "done") {
      const current = this.turns.get(event.sessionId);
      // 与用户回显同一个 id（runtime 把回显 id 传给 recall）；只补不覆盖
      if (current !== undefined && current.turnId === null) current.turnId = event.turnId;
      return;
    }
    if (
      event.type === "progress" &&
      event.progress.type === "item_finished" &&
      event.progress.item.role === "assistant" &&
      event.progress.item.status === "complete"
    ) {
      const current = this.turns.get(event.sessionId);
      if (current !== undefined) current.answered = true;
      return;
    }
    if (event.type === "phase" && event.phase === "idle") {
      this.settle(event.sessionId);
    }
  }

  /** 会话被删：挂着的轮按「没有尾账」直接丢（存档是养分，不是欠款）。 */
  forget(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  private settle(sessionId: string): void {
    const current = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (current === undefined || current.turnId === null || !current.answered) return;
    void this.ingest(sessionId, current.turnId, current.text, current.pasted);
  }

  private async ingest(sessionId: string, turnId: string, text: string, pasted: readonly string[]): Promise<void> {
    try {
      const intent = await this.deps.readIntent(sessionId);
      if (intent === null) return;
      const detail = await this.deps.load(sessionId);
      // a：本轮最后一条 assistant 的最后一段文字。转录刚落完盘，尾部就是本轮；
      // 读不到就放弃（宁可不存档，不存半截答案）
      if (detail === null) {
        console.error("[intent-ingest] 转录读不到，本轮不存档", sessionId);
        return;
      }
      await this.deps.http.post(
        `${intent.baseUrl}/ingest`,
        ingestRowOf(sessionId, turnId, detail.title, text, pasted, detail.transcript, Date.now()),
      );
    } catch (cause) {
      // 契约：/ingest 失败只记日志，不影响对话
      console.error("[intent-ingest] 存档失败（不影响对话）", sessionId, cause);
    }
  }
}
