/**
 * 会话记忆（memory v1）的契约真源：条目形状与问答载荷。
 *
 * 设计取向（三个参考系统的调研结论，详见各 commit message）：
 * - **入库前蒸馏**：条目是自包含、第三人称、时间绝对的陈述句（atommem 的原子事实
 *   ≡ mandol 的 God Mode 改写，两家实测共同指向的最大杠杆），不是原始对话片段。
 * - **词法召回**：语料小、条目本身是高信号蒸馏句，关键词+正文重叠打分够用；
 *   向量检索刻意缓办（打分器在 `src/main/memory/retrieve.ts`，留扩展位）。
 * - **按作用域隔离**：scopeId 由主进程按会话归属解析（workspaceId ?? cwd），
 *   agent 进程不碰 userData（readTaskRequest 同一条边界）。
 */

/** 一条蒸馏后的记忆条目。 */
export interface MemoryEntry {
  /** `mem_` 前缀的 uuid（主进程落盘时分配，蒸馏侧不造 id） */
  id: string;
  /** 自包含、第三人称、时间绝对的陈述句 */
  text: string;
  /** 蒸馏时模型给的提取词（≤8 个），全文检索的主信号 */
  keywords: string[];
  /** 来源会话 id（溯源用） */
  sessionId: string;
  /** 来源轮的用户消息时间（epoch ms） */
  timestamp: number;
}

/** 召回命中：条目 + 归一化分（0..1，越高越相关）。 */
export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
}

/**
 * memoryRetrieveRequest 的回执载荷（readTaskResult 同款的 ok 双分支）。
 * 空库 / 无命中也是 ok: true 配空 hits——「没东西可注入」不是错误。
 */
export type MemoryRetrieveOutcome = { ok: true; hits: MemoryHit[] } | { ok: false; error: string };

/**
 * 蒸馏侧产出、待落盘的条目（还没有 id / sessionId，那两个由主进程落盘时补）。
 * 与 MemoryEntry 分开：id 的分配权在落盘侧，蒸馏侧不该能伪造来源。
 */
export interface MemoryDraft {
  text: string;
  keywords: string[];
  /** 来源轮的用户消息时间（epoch ms） */
  timestamp: number;
}
