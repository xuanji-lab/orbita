/**
 * 轮前召回的注入块组装（memory v1）。**纯模块**，可被 `node --test` 直接加载。
 *
 * 注入块拼在用户 prompt 文本的**尾部**（echoAndPrompt）：KV cache 只破尾段，
 * 前缀复用不受影响（ZCode 的缓存纪律）。回显账本记的是注入后的完整文本——
 * pi 回声对账认的是实际发出去的串。
 *
 * 召回、打分、门控都在主进程（main/memory/retrieve.ts）；这里只做组装与兜底预算。
 */
import type { MemoryHit } from "../shared/memory.ts";
import { formatDate } from "./memory-distill.ts";

/**
 * 注入块的总字符兜底预算。主进程召回侧已有同值预算（retrieve.ts 的 MAX_CHARS），
 * 这里是第二道——两侧各自夹住，谁也不信谁的输入（条目数据跨进程来）。
 */
const BLOCK_BUDGET_CHARS = 1500;

/**
 * 命中 → 注入块；空命中返回 null（调用方不注入、照常开轮）。
 * 超预算的条目整条跳过试下一条——半句话比没有更难用；第一条永远装
 * （它是最高分，一条都不装等于召回白做）。
 */
export function buildMemoryBlock(hits: readonly MemoryHit[]): string | null {
  if (hits.length === 0) return null;
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const line = `- [${formatDate(hit.entry.timestamp)}] ${hit.entry.text}`;
    if (lines.length > 0 && used + line.length > BLOCK_BUDGET_CHARS) continue;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return null;
  return (
    "\n\n<orbita-memory>\n以下条目来自本工作区既往会话的记忆，与当前输入无关时忽略：\n" +
    lines.join("\n") +
    "\n</orbita-memory>"
  );
}
