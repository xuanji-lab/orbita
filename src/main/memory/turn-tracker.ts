/**
 * 记忆构建的轮次跟踪器（主进程侧）——intent-ingest.ts 的同款模式：submit 时记下
 * 本轮原话（begin），事件流盯回显与回答完成，轮落定（phase idle）且**正常结束**
 * 时把这一轮交给记忆服务（turnSettled）。出错、取消、未回答的轮不交——半截与
 * 张冠李戴的段比没有更糟。
 *
 * 纯模块（不 import electron，可被 `node --test` 直接加载）：转录 / meta / 设置 /
 * 家务活模型装配与转发全部注入。
 *
 * **只跟踪根会话的用户原话**（intent-env 的同一条口径）：begin 之前调用方先过
 * memoryBuildEligible。子会话读记忆（召回照常）但不写——写入门禁只有这一处。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { memoryScopeOf, type MemoryChoreModel } from "../../shared/memory.ts";
import { parseChannelPrompt } from "../../shared/channel.ts";
import { isClosingScanText } from "../../shared/wrapup-scan.ts";
import type { SessionRecord } from "../../shared/session.ts";
import type { MemoryTurnPayload } from "./host-core.ts";

interface TurnState {
  /** submit 带来的用户原话（含指令前缀，与 agent 收到的 prompt 同源） */
  text: string;
  /** 本轮用户回显的时间戳（item_started 盖的）；null = 还没回显 */
  echoedAt: number | null;
  /** 出现过一条 complete 的 assistant 终态 */
  answered: boolean;
}

/**
 * 这一轮要不要进构建：根会话（无 parentId）+ 用户亲口说的话（不是父子信封、
 * 不是收尾扫描的机器提问、非空）。
 */
export function memoryBuildEligible(meta: { parentId?: string } | null, text: string): boolean {
  if (meta?.parentId !== undefined) return false;
  if (parseChannelPrompt(text) !== null) return false;
  if (isClosingScanText(text)) return false;
  return text.trim() !== "";
}

/**
 * 本轮的回答正文：转录里最后一条 complete 的 assistant 记录的全部文字块。
 * 取全部而不只最后一段——事件段的快照要的是「这轮聊了什么」，结论在尾巴上
 * （截断在契约的 memoryTurnSnapshot 做：助手话取尾部）。
 */
export function completedAssistantText(records: readonly SessionRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || record.role !== "assistant" || record.status !== "complete") continue;
    let text = "";
    for (const block of record.content) {
      if (block.type === "text") text += block.text;
    }
    return text;
  }
  return null;
}

export interface MemoryTurnDeps {
  /** 读转录（settle 时取回答正文与轮号）；null = 会话没了 */
  load: (sessionId: string) => Promise<{ transcript: readonly SessionRecord[] } | null>;
  /** 读会话归属（解析作用域）；null = meta 读不到（宁可不记，不猜作用域） */
  readMeta: (sessionId: string) => Promise<{ workspaceId: string | null; cwd: string } | null>;
  /** settle 时现读实验开关（用户可能刚把开关关了） */
  isMemoryOn: () => Promise<boolean>;
  /** settle 时现装配家务活模型；undefined = 没配（服务侧记日志后跳过） */
  readChore: () => Promise<MemoryChoreModel | undefined>;
  /** 交给记忆服务（host.turnSettled） */
  settle: (payload: MemoryTurnPayload) => void;
}

export class MemoryTurnTracker {
  private readonly turns = new Map<string, TurnState>();
  private readonly deps: MemoryTurnDeps;

  constructor(deps: MemoryTurnDeps) {
    this.deps = deps;
  }

  /** submit / interrupt 发出时记下本轮原话（调用方已过 memoryBuildEligible）。 */
  begin(sessionId: string, text: string): void {
    this.turns.set(sessionId, { text, echoedAt: null, answered: false });
  }

  /** 事件流喂进来：盯本轮回显、assistant 完成、轮落定（intent-ingest 同款）。 */
  onEvent(event: AgentEvent): void {
    if (event.type === "phase" && event.phase === "turn") {
      // 新一轮开跑：上一轮没走到 settle 就被翻页 = 出错 / 抢跑，重置回答标记
      const current = this.turns.get(event.sessionId);
      if (current !== undefined) current.answered = false;
      return;
    }
    if (
      event.type === "progress" &&
      event.progress.type === "item_started" &&
      event.progress.item.role === "user"
    ) {
      const current = this.turns.get(event.sessionId);
      if (current !== undefined && current.echoedAt === null) {
        current.echoedAt = event.progress.item.timestamp;
      }
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

  /** 会话被删：挂着的轮直接丢（记忆是养分，不是欠款）。 */
  forget(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  private settle(sessionId: string): void {
    const current = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (current === undefined || current.echoedAt === null || !current.answered) return;
    void this.deliver(sessionId, { text: current.text, echoedAt: current.echoedAt });
  }

  private async deliver(sessionId: string, current: { text: string; echoedAt: number }): Promise<void> {
    try {
      if (!(await this.deps.isMemoryOn())) return;
      const [detail, meta] = await Promise.all([this.deps.load(sessionId), this.deps.readMeta(sessionId)]);
      // 读不到就放弃（宁可不记，不记半截或猜错作用域）
      if (detail === null || meta === null) return;
      const assistantText = completedAssistantText(detail.transcript);
      if (assistantText === null || assistantText.trim() === "") return;
      // 轮号：转录里 user 记录的条数（此刻本轮回显已落盘，含本轮）。与 renderer
      // 划选引用的轮号同口径（按用户消息计，1 起）
      const turn = detail.transcript.filter((record) => record.role === "user").length;
      this.deps.settle({
        sessionId,
        scopeId: memoryScopeOf(meta),
        turn,
        at: current.echoedAt,
        userText: current.text,
        assistantText,
        chore: await this.deps.readChore(),
      });
    } catch (cause) {
      // 记忆是易耗品：这一轮交不出去只记日志，不打扰任何人
      console.error("[memory] 轮后事件没交给记忆服务（这一轮不进事件段）", sessionId, cause);
    }
  }
}
