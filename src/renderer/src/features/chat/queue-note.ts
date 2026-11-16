/**
 * 排队条每一行行尾的注脚：这条什么时候会发出去。纯函数：不 import React，可被 `node --test` 直接加载（QueueStrip 是唯一调用点）。
 *
 * 已插进正在跑的这一轮（子会话消息开的轮里用户发话，agent:steer）：当前这一步做完、下一次请求前就送到——不是等整轮结束
 * （实例实测：父在跑 12 秒的命令时用户发话，命令跑完同一轮的下一次请求里模型就看到了）。
 */
import type { QueuedMessage } from "./session-states.ts";
import type { Messages } from "../../messages-en.ts";

export function queueNote(item: QueuedMessage, phase: "idle" | "turn" | "compaction", t: Messages): string {
  if (item.kind === "compact") return t.queue.compactsWhenIdle;
  if (item.kind === "text" && item.steered === true && phase === "turn") return t.queue.steered;
  if (phase === "compaction") return t.queue.waitsCompaction;
  if (phase === "idle") return t.queue.haltedNote;
  return t.queue.waitsTurnEnd;
}
