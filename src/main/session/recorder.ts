/**
 * agent 事件 → 落盘。**纯模块**：不 import electron，可被 `node --test` 直接加载。
 *
 * 认三个终态帧：
 *
 *   assistant  `item_finished`  —— message_end 时 adapter 发的终态帧
 *   user       `item_started`   —— 用户消息出生即完成，adapter 不会再给它发 finished
 *   compacted  `compaction`     —— 压缩界碑，事件里就是完整的记录，直接落
 *
 * **abort 的半截回答同样落盘**，这是刻意的。pi 的 agent-loop 在 abort 时先无条件发
 * `message_end`、之后才判 `stopReason === "aborted"`，所以它照样走终态帧。
 * 不落的话，重开会话看到的会**比当时屏幕上少一截**——用户已经读过那半句了，
 * 悄悄抹掉比留着更糟。半截与说完的区别由 item 的 `status`（aborted / complete）承载，
 * 不由「存不存」承载。
 *
 * **不做归约。** 归约是渲染层的事（用 pi 自带的归约器），这里只挑终态帧。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import type { SessionRecord } from "../../shared/session.ts";
import type { SessionStore } from "./store.ts";

export function createSessionRecorder(store: SessionStore): (event: AgentEvent) => void {
  // 写失败不该让对话中断——记一条到 stderr，界面照常
  const persist = (sessionId: string, item: SessionRecord): void => {
    void store.record(sessionId, item).catch((error: unknown) => {
      console.error("[session] 落盘失败", sessionId, error);
    });
  };
  return (event) => {
    if (event.type === "compaction") return persist(event.sessionId, event.record);
    if (event.type === "title") {
      // 标题落 meta 不落 transcript——它不是对话的一部分。store 内部核验
      // titleSource 仍是 derived 才写，迟到的标题盖不掉用户刚改的名字。
      void store
        .setAutoTitle(event.sessionId, event.title)
        .catch((error: unknown) => console.error("[session] 标题落盘失败", event.sessionId, error));
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
    if (item === null) return;
    persist(event.sessionId, item);
  };
}
