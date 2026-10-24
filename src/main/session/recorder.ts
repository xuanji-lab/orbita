/**
 * agent 事件 → 落盘。**纯模块**：不 import electron，可被 `node --test` 直接加载。
 *
 * 认三个终态帧：
 *
 *   assistant  `item_finished`  —— message_end 时 adapter 发的终态帧
 *   user       `item_started`   —— 用户消息出生即完成，adapter 不会再给它发 finished
 *   compacted  `compaction`     —— 压缩界碑，事件里就是完整的记录，直接落
 *
 * **唯一不收的终态帧**：空 error 回答（status=error 且内容为空的 assistant，见
 * store.ts 的 isEmptyErrorAssistant）——auto_retry 的失败尝试会产生它，非流式阶段
 * （工具执行中 / 两次模型调用之间）被 interrupt 打断时 pi 产出的也是这个形状。
 * **pi 的本子会收它，我们刻意不收**：它不带任何上下文，存下来只是 UI 上一个空
 * 错误气泡。两本账由此产生的差异，由分支对账侧对 pi 条目施加同一谓词来抵消
 * （branch-cut.ts 的 isEmptyErrorAssistantEntry）。
 *
 * **abort 的半截回答同样落盘**，这是刻意的。pi 的 agent-loop 在 abort 时先无条件发
 * `message_end`、之后才判 `stopReason === "aborted"`，所以它照样走终态帧。
 * 不落的话，重开会话看到的会**比当时屏幕上少一截**——用户已经读过那半句了，
 * 悄悄抹掉比留着更糟。半截与说完的区别由 item 的 `status`（aborted / complete）承载，
 * 不由「存不存」承载。
 *
 * **不做归约。** 归约是渲染层的事（用 pi 自带的归约器），这里只挑终态帧。
 *
 * **assistant 记录盖上本轮生效的思考档**（`StampedAssistantRecord.thinkingLevel`）：取开轮时
 * runtime 推的 `thinking` 事件——clamp 之后的真值，不是用户点的意图档。pi 的本子在会话中途
 * 改档时不记（理由见 shared/session.ts），价格 · 能力图按「型号 × 档」算每任务成本要靠这一章。
 * 手动压缩时 runtime 会先推 off、压完再推回原档；压缩不产生 assistant 记录，盖到的总是回来那一档。
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { parseChannelPrompt } from "../../shared/channel.ts";
import { stampedThinkingLevel, type ChannelMarkRecord, type SessionRecord } from "../../shared/session.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { usageCountsOfIntent } from "../../shared/intent-recall.ts";
import { isEmptyErrorAssistant, type SessionStore } from "./store.ts";
import type { TaskLedger } from "../usage/task-ledger.ts";
import { taskRecordOf } from "../usage/task-cost.ts";

export function createSessionRecorder(
  store: SessionStore,
  /**
   * 任务账本（侧栏用量格与价格 · 能力图共用，可选——旧夹具不传则不记）。assistant 记录落盘的
   * 同一条路径上按「会话 × 型号 × 档的连续一段」增量记账，档取记录上刚盖的章；意图召回的 token
   * 另记一份按天的账。失败不拦对话——账本是可以从会话 JSONL 重建的派生数据。
   */
  tasks?: TaskLedger,
): (event: AgentEvent) => void {
  // 写失败不该让对话中断——记一条到 stderr，界面照常
  const persist = (sessionId: string, item: SessionRecord): void => {
    void store.record(sessionId, item).catch((error: unknown) => {
      console.error("[session] 落盘失败", sessionId, error);
    });
    if (tasks !== undefined && item.role === "assistant") {
      const task = taskRecordOf(item, stampedThinkingLevel(item));
      if (task !== null) {
        void tasks.record(sessionId, task).catch((error: unknown) => {
          console.error("[task-ledger] 任务账记账失败", sessionId, error);
        });
      }
    }
  };
  /** 每条会话最近一次 thinking 事件的档（进程重启后为空：下一轮开轮必推一次，先于任何 assistant 记录） */
  const turnLevels = new Map<string, ThinkingLevel>();
  return (event) => {
    if (event.type === "thinking") {
      turnLevels.set(event.sessionId, event.level);
      return;
    }
    if (event.type === "compaction") return persist(event.sessionId, event.record);
    // 意图召回的终态记录（实验功能）：落盘进会话 JSONL；带 usage 时同步进任务账本的意图召回那一份
    // （DeepSeek / Proma 管线花的是用户自己的 token，账本可从记录回填重建）
    if (event.type === "intentRecallRecord") {
      persist(event.sessionId, event.record);
      if (tasks !== undefined && event.record.usage !== undefined) {
        void tasks
          .recordIntent({
            id: event.record.id,
            timestamp: event.record.timestamp,
            tokens: usageCountsOfIntent(event.record.usage),
          })
          .catch((error: unknown) => {
            console.error("[usage] 意图召回的 token 账没记上", event.sessionId, error);
          });
      }
      return;
    }
    if (event.type === "title") {
      // 标题落 meta 不落 transcript——它不是对话的一部分。store 内部核验
      // titleSource 仍是 derived 才写，迟到的标题盖不掉用户刚改的名字。
      void store
        .setAutoTitle(event.sessionId, event.title)
        .catch((error: unknown) => console.error("[session] 标题落盘失败", event.sessionId, error));
      return;
    }
    if (event.type === "stats") {
      // 用量落 meta 不落 transcript——它是一份快照，不是对话里的一条。
      // **只落带 persist 的那几帧**（settled / 压缩结束 / 建会话）：不分的话，
      // 一轮 30 个工具就是 30 次「读-改-原子写」，而界面要的那些中间帧本来就不需要存。
      if (event.persist !== true) return;
      void store
        .setStats(event.sessionId, event.stats)
        .catch((error: unknown) => console.error("[session] 用量落盘失败", event.sessionId, error));
      return;
    }
    if (event.type === "model") {
      // 会话内换模型（C-4）成功：providerId / modelId 落 meta 不落 transcript——
      // 分支继承、重开播种、resume 对齐都读它。失败走 failed 事件，不经过这里。
      void store
        .setModel(event.sessionId, event.providerId, event.modelId)
        .catch((error: unknown) => console.error("[session] 模型切换落盘失败", event.sessionId, error));
      return;
    }
    if (event.type !== "progress") return;
    const progress = event.progress;
    const item =
      progress.type === "item_finished"
        ? progress.item
        : progress.type === "item_started" && progress.item.role === "user"
          ? progress.item
          : null;
    if (item === null || isEmptyErrorAssistant(item)) return;
    // 通道投递信封的接收侧标记（子会话 2026-09-23 设计修订）：一条 user 的
    // item_started，首个 text 块能被 parseChannelPrompt 解析，说明这不是用户
    // 说的话，是主进程投给这条会话的通道消息——落一条 ChannelMarkRecord，
    // 不落 user 消息（正文只有一份，在通道账本里）。
    if (item.role === "user") {
      const mark = channelMarkOf(item);
      if (mark !== null) {
        persist(event.sessionId, mark);
        return;
      }
    }
    const level = item.role === "assistant" ? turnLevels.get(event.sessionId) : undefined;
    persist(event.sessionId, item.role === "assistant" && level !== undefined ? { ...item, thinkingLevel: level } : item);
  };
}

/** user 记录的首个 text 块能否解出信封；不能（普通用户消息）返回 null。 */
function channelMarkOf(item: Extract<TranscriptItem, { role: "user" }>): ChannelMarkRecord | null {
  const text = item.content.find((block) => block.type === "text");
  if (text === undefined || text.type !== "text") return null;
  const parsed = parseChannelPrompt(text.text);
  if (parsed === null) return null;
  return {
    role: "channel-mark",
    id: item.id,
    peerId: parsed.peerId,
    messageId: parsed.messageId,
    from: parsed.from,
    kind: parsed.kind,
    timestamp: item.timestamp,
  };
}
