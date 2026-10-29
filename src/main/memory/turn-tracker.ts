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
 *
 * **回答正文取自事件流，不读盘**（PR #374 真机 b4669e3f 第 3 轮丢失的根因）：
 * recorder 的落盘是异步的、排在会话的 meta 写入链后面，idle 到达时最终回答
 * 常常还没 append 进 JSONL。旧实现在 idle 后读盘取「最后一条 complete 的
 * assistant」——带工具调用的轮读到的是只有 toolCall、没有文字的那条，正文为空，
 * 整轮静默丢掉；不带工具的轮读到的是上一轮的回答（张冠李戴）。事件里的
 * item_finished 本身就是完整的终态条目，直接用它。
 *
 * **丢弃必留痕**：本轮因任何原因不交给服务时打一行 `[memory] 轮后跟踪：…` 的
 * 诊断（会话、轮号、走了哪条路径、回显 / 回答 / 工具往返的状态），正常交付不打。
 * 「会话没有挂着的轮」（子会话、通道信封、收尾扫描、开关关着时开的轮、压缩轮）
 * 是设计上的不跟踪，不打——它们每轮都会出现，打了就是噪音；挂着的轮被意外
 * 弄丢的那一刻（被新一轮顶掉 / 提前落定）各有一行。
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
  /** 回显条目的 id（落盘后就是转录里那条 user 记录的 id，用来定轮号） */
  echoId: string | null;
  /**
   * 本轮**最后一个** assistant 终态帧是正常说完的（complete 且不是 toolUse）。
   * 按「最后一帧」判而不是「出现过一帧」：先说半句再调工具、随后出错 / 被打断的轮，
   * 最后一帧是 error / aborted，不该交。
   */
  answered: boolean;
  /** 最后一个正常说完的 assistant 终态帧的全部文字块（事件段的回答快照） */
  answerText: string;
  /** 本轮 toolUse 的 assistant 帧数（诊断用：带工具调用的轮是否特别容易丢） */
  toolRounds: number;
  /** 最后一个 assistant 终态帧的 status / stopReason（诊断用）；null = 一帧都没有 */
  lastAssistant: string | null;
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
 * 本轮轮号（按用户消息计，1 起；与 renderer 划选引用的轮号同口径）：回显条目在
 * 转录 user 记录里的位置。回显还没落盘（找不到这个 id）时它就是下一条——
 * user 记录数 + 1。不在磁盘时机上赌。
 */
export function turnNumberOf(transcript: readonly SessionRecord[], echoId: string | null): number {
  const users = transcript.filter((record) => record.role === "user");
  const index = echoId === null ? -1 : users.findIndex((record) => record.id === echoId);
  return index >= 0 ? index + 1 : users.length + 1;
}

export interface MemoryTurnDeps {
  /** 读转录（settle 时定轮号）；null = 会话没了 */
  load: (sessionId: string) => Promise<{ transcript: readonly SessionRecord[] } | null>;
  /** 读会话归属（解析作用域）；null = meta 读不到（宁可不记，不猜作用域） */
  readMeta: (sessionId: string) => Promise<{ workspaceId: string | null; cwd: string } | null>;
  /** settle 时现读实验开关（用户可能刚把开关关了） */
  isMemoryOn: () => Promise<boolean>;
  /** settle 时现装配家务活模型；undefined = 没配（服务侧记日志后跳过） */
  readChore: () => Promise<MemoryChoreModel | undefined>;
  /** 交给记忆服务（host.turnSettled）；返回 Promise 时失败由这里接住记日志 */
  settle: (payload: MemoryTurnPayload) => void | Promise<void>;
  /** 丢弃诊断的出口（默认 console.log；测试注入断言） */
  log?: (message: string, ...args: unknown[]) => void;
}

export class MemoryTurnTracker {
  private readonly turns = new Map<string, TurnState>();
  private readonly deps: MemoryTurnDeps;
  private readonly log: (message: string, ...args: unknown[]) => void;

  constructor(deps: MemoryTurnDeps) {
    this.deps = deps;
    this.log = deps.log ?? ((message, ...args) => console.log(message, ...args));
  }

  /** submit / interrupt 发出时记下本轮原话（调用方已过 memoryBuildEligible）。 */
  begin(sessionId: string, text: string): void {
    const previous = this.turns.get(sessionId);
    if (previous !== undefined) {
      // interrupt（立即发送）抢跑：旧轮被停、不发 idle，它的状态就在这里被顶掉；
      // 没回显过 = 上次登记后轮根本没开起来（submit 抛错等）
      this.dropped(
        sessionId,
        previous,
        previous.echoedAt === null
          ? "上次登记的轮没开起来（从没回显），被新一轮的登记覆盖"
          : "上一轮没落定就被新一轮顶掉（立即发送 / 抢跑）",
      );
    }
    this.turns.set(sessionId, {
      text,
      echoedAt: null,
      echoId: null,
      answered: false,
      answerText: "",
      toolRounds: 0,
      lastAssistant: null,
    });
  }

  /** 事件流喂进来：盯本轮回显、assistant 终态帧、轮落定（intent-ingest 同款）。 */
  onEvent(event: AgentEvent): void {
    // 注意：phase "turn" **不再**重置回答标记。它不只在开轮时来——回答完之后 pi 做
    // 阈值 / 溢出自动压缩，compaction_end 也会让 runtime 发一次 phase "turn"，旧实现
    // 在这里把已说完的轮清成「没回答」，idle 时整轮静默丢掉。轮的边界由 begin 划
    // （每轮新建状态），「正常结束」由最后一个 assistant 终态帧判。
    if (
      event.type === "progress" &&
      event.progress.type === "item_started" &&
      event.progress.item.role === "user"
    ) {
      const current = this.turns.get(event.sessionId);
      if (current !== undefined && current.echoedAt === null) {
        current.echoedAt = event.progress.item.timestamp;
        current.echoId = event.progress.item.id;
      }
      return;
    }
    if (
      event.type === "progress" &&
      event.progress.type === "item_finished" &&
      event.progress.item.role === "assistant"
    ) {
      const current = this.turns.get(event.sessionId);
      if (current === undefined) return;
      const item = event.progress.item;
      current.lastAssistant = `${item.status}/${item.stopReason}`;
      if (item.status === "complete" && item.stopReason === "toolUse") {
        // 调工具前的那一帧：说完的不是这一轮的回答，后面还有
        current.toolRounds += 1;
        current.answered = false;
        return;
      }
      current.answered = item.status === "complete";
      if (current.answered) {
        let text = "";
        for (const block of item.content) {
          if (block.type === "text") text += block.text;
        }
        current.answerText = text;
      }
      return;
    }
    if (event.type === "phase" && event.phase === "idle") {
      this.settle(event.sessionId);
    }
  }

  /** 会话被删：挂着的轮直接丢（记忆是养分，不是欠款；会话都没了，不留诊断）。 */
  forget(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  private settle(sessionId: string): void {
    const current = this.turns.get(sessionId);
    // 没有挂着的轮 = 设计上不跟踪的轮（见头注释），不打日志
    if (current === undefined) return;
    this.turns.delete(sessionId);
    if (current.echoedAt === null) {
      this.dropped(sessionId, current, "落定时还没见到用户回显");
      return;
    }
    if (!current.answered) {
      this.dropped(sessionId, current, "最后一个 assistant 终态帧不是正常说完（出错 / 被打断 / 停在工具调用 / 没回答）");
      return;
    }
    if (current.answerText.trim() === "") {
      this.dropped(sessionId, current, "回答正文为空");
      return;
    }
    void this.deliver(sessionId, current, current.echoedAt);
  }

  private async deliver(sessionId: string, current: TurnState, echoedAt: number): Promise<void> {
    try {
      if (!(await this.deps.isMemoryOn())) {
        this.dropped(sessionId, current, "落定时实验开关已关");
        return;
      }
      const [detail, meta] = await Promise.all([this.deps.load(sessionId), this.deps.readMeta(sessionId)]);
      // 读不到就放弃（宁可不记，不记半截或猜错作用域）
      if (detail === null || meta === null) {
        this.dropped(
          sessionId,
          current,
          detail === null ? "转录读不到（会话没了）" : "会话 meta 读不到（不猜作用域）",
          detail === null ? undefined : turnNumberOf(detail.transcript, current.echoId),
        );
        return;
      }
      await this.deps.settle({
        sessionId,
        scopeId: memoryScopeOf(meta),
        turn: turnNumberOf(detail.transcript, current.echoId),
        at: echoedAt,
        userText: current.text,
        assistantText: current.answerText,
        chore: await this.deps.readChore(),
      });
    } catch (cause) {
      // 记忆是易耗品：这一轮交不出去只记日志，不打扰任何人
      this.log(`[memory] 轮后跟踪：会话 ${sessionId} 的这一轮没交给记忆服务（这一轮不进事件段）`, describe(current), cause);
    }
  }

  /**
   * 丢弃诊断：轮号已知就直接写；不知道就现读一次转录推（只在丢弃时读，正常路径
   * 不多一次 IO）。读失败写「轮号未知」——诊断自己不能再抛。
   */
  private dropped(sessionId: string, current: TurnState, path: string, knownTurn?: number): void {
    const emit = (turn: string): void => {
      this.log(`[memory] 轮后跟踪：会话 ${sessionId} ${turn}不进事件段——${path}`, describe(current));
    };
    if (knownTurn !== undefined) {
      emit(`第 ${knownTurn} 轮`);
      return;
    }
    void this.deps
      .load(sessionId)
      .then((detail) => emit(detail === null ? "（轮号未知）" : `第 ${turnNumberOf(detail.transcript, current.echoId)} 轮`))
      .catch(() => emit("（轮号未知）"));
  }
}

function describe(current: TurnState): string {
  return [
    `echoedAt=${current.echoedAt ?? "null"}`,
    `answered=${current.answered}`,
    `工具往返=${current.toolRounds}`,
    `末帧=${current.lastAssistant ?? "无"}`,
    `回答字数=${current.answerText.length}`,
  ].join(" ");
}
