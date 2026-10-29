/**
 * 轮前召回的注入块：组装（buildMemoryBlock）与**附件式挂载**（memoryAttachments /
 * attachMemoryBlocks）。**纯模块**，可被 `node --test` 直接加载。
 *
 * 为什么是附件、不是拼进用户消息（2026-10-29 用户裁决「不想强制 append 进消息里」）：
 * 召回块不进用户原话——pi 本子与 orbita 转录里那条用户消息保持原样（QA 不被机器话
 * 改写）。召回结果作为一条 custom entry（MEMORY_ATTACH_ENTRY）落在本子里，键是那条
 * 用户消息的时间戳；每次发往模型前（context 事件，wire-only，同 user-context 的
 * 时间情境）把它作为**独立的 text 块**挂回那条消息的末尾。
 *
 * 缓存纪律：块文本落本即定格，此后每轮按本子逐字节重放——历史前缀不变，只有本轮
 * 新消息带新块。2026-10-29 实测（子会话 675dbb46 的 cache-probe-report）：智谱 /
 * DeepSeek 网关 / Kimi / Claude 网关第 2–4 轮命中 95–99%，与不带附件的基线相当；
 * 四家模型都读得到附件内容。**不能**下一轮重新召回再改写旧块——那就断了前缀。
 *
 * 召回、打分、门控都在记忆服务进程（memory/retrieve.ts）；这里只做组装、兜底预算与挂载。
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { memoryShortId, type MemoryHit } from "../shared/memory.ts";
import type { ContextMessage } from "./image-byte-budget.ts";

/** pi 本子里记忆附件的 custom entry 类型名（data = { at: 用户消息时间戳, text: 块文本 }）。 */
export const MEMORY_ATTACH_ENTRY = "orbita-memory-attach";

/** 本地时区的 YYYY-MM-DD（条目时间的展示格式；#228 的 formatDate 同款）。 */
function formatDate(now: number): string {
  const date = new Date(now);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 注入块的总字符兜底预算。召回侧已有同值预算（retrieve.ts 的 MAX_CHARS +
 * 常驻预算），这里是第二道——两侧各自夹住，谁也不信谁的输入（条目数据跨进程来）。
 */
const BLOCK_BUDGET_CHARS = 3000;

/** 块的说明句（读者是模型）。canRevise = 根会话、注册了记忆工具：讲清纠错要动手改。 */
const BLOCK_INTRO = "以下条目来自既往会话的记忆（方括号里是条目 id 与日期），与当前输入无关时忽略";
const BLOCK_REVISE_HINT =
  "用户纠正其中某条时，用 memory_revise 按 id 改掉它（只说不对、没有新说法用 memory_retire），不要只在回复里口头答应";

/**
 * 命中 → 注入块；空命中返回 null（调用方不注入、照常开轮）。
 * 每行带短 id（memoryShortId）：用户说「刚才那条不对」时模型不用先查就能直接定位。
 * 块落本即定格、逐字节重放——格式变了只影响新轮的块，旧附件不动。
 * 超预算的条目整条跳过试下一条——半句话比没有更难用；第一条永远装
 * （它是最高分，一条都不装等于召回白做）。
 */
export function buildMemoryBlock(
  hits: readonly MemoryHit[],
  options: { canRevise: boolean } = { canRevise: false },
): string | null {
  if (hits.length === 0) return null;
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const line = `- [${memoryShortId(hit.entry.id)} · ${formatDate(hit.entry.at)}] ${hit.entry.text}`;
    if (lines.length > 0 && used + line.length > BLOCK_BUDGET_CHARS) continue;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return null;
  const intro = options.canRevise ? `${BLOCK_INTRO}；${BLOCK_REVISE_HINT}：` : `${BLOCK_INTRO}：`;
  return `<orbita-memory>\n${intro}\n${lines.join("\n")}\n</orbita-memory>`;
}

/**
 * 从本子（当前叶子路径）读回各轮的记忆附件：用户消息时间戳 → 块文本。
 * 坏 entry 跳过；同一时间戳出现两次以先落的为准（定格的那份才是发出去过的）。
 */
export function memoryAttachments(branch: readonly SessionEntry[]): Map<number, string> {
  const attached = new Map<number, string>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== MEMORY_ATTACH_ENTRY) continue;
    const data = entry.data as { at?: unknown; text?: unknown } | undefined;
    if (typeof data?.at !== "number" || !Number.isFinite(data.at) || typeof data.text !== "string") continue;
    if (data.text === "" || attached.has(data.at)) continue;
    attached.set(data.at, data.text);
  }
  return attached;
}

/**
 * 本轮的记忆附件状态：本子里读回的 `attached`，加上本轮召回到、还没认领到用户消息
 * 上的 `pending`（第一次 LLM 调用时认领给最后一条用户消息——那就是本轮的 prompt；
 * 之后的 steer / 通道消息不带记忆）。
 */
export interface TurnMemoryAttach {
  attached: Map<number, string>;
  pending: string | null;
  /** 本轮轮号（开轮回显前算好；记忆工具记 revise 新条的出处轮用）。缺席 = 还没开轮 */
  turn?: number;
}

/**
 * context 事件的纯核：认领 pending（返回要落本的 record），并把每条有附件的用户
 * 消息挂上独立 text 块（末尾）。**不改入参**；没有任何附件时 messages 为 null
 * （不替换，省一次数组拷贝）。
 */
export function attachMemoryBlocks(
  messages: readonly ContextMessage[],
  state: TurnMemoryAttach,
): { messages: ContextMessage[] | null; record: { at: number; text: string } | null } {
  let record: { at: number; text: string } | null = null;
  if (state.pending !== null) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index] as { role?: unknown; timestamp?: unknown };
      if (candidate.role !== "user") continue;
      if (typeof candidate.timestamp === "number" && !state.attached.has(candidate.timestamp)) {
        record = { at: candidate.timestamp, text: state.pending };
        state.attached.set(candidate.timestamp, state.pending);
      }
      break;
    }
    state.pending = null;
  }
  if (state.attached.size === 0) return { messages: null, record };
  let touched = false;
  const next = messages.map((message) => {
    const candidate = message as { role?: unknown; timestamp?: unknown; content?: unknown };
    if (candidate.role !== "user" || typeof candidate.timestamp !== "number") return message;
    const text = state.attached.get(candidate.timestamp);
    if (text === undefined) return message;
    touched = true;
    const block = { type: "text" as const, text };
    const content =
      typeof candidate.content === "string"
        ? [{ type: "text" as const, text: candidate.content }, block]
        : Array.isArray(candidate.content)
          ? [...candidate.content, block]
          : [block];
    return { ...message, content } as ContextMessage;
  });
  return { messages: touched ? next : null, record };
}
