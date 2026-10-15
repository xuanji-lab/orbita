/**
 * 摘抄：用户在对话里划选一段（自己的或 agent 的）存下来，之后在审查面板的「摘抄」
 * 页签里按会话 / 全部翻、按关键词搜、点回原文。
 *
 * **只是收藏，不进模型**（2026-10-15 用户裁决：记忆系统先不做，只做复制和摘抄）。
 * 所以没有态度标注、没有常驻注入——那些是给记忆系统推断立场用的，单独存在
 * 只是多一步操作。存逐字原文 + 出处（会话、第几轮、谁说的），出处用来跳回原文。
 *
 * 存储在主进程（userData 下一份只追加 JSONL，删除走原子重写）；renderer 只经下面
 * 三个通道读写。与 agent 的 ipcChannels 分开：摘抄是独立域，agent 进程不碰它。
 */
import type { QuoteRole } from "./quote.ts";

/** 一条摘抄。 */
export interface Excerpt {
  /** `exc_` 前缀的 uuid（主进程落盘时分配） */
  id: string;
  /** 逐字原文（划选时的选区文字，保留换行；首尾空白已去掉） */
  text: string;
  /** 出处会话 */
  sessionId: string;
  /** 出处轮号（按用户消息计，1 起）；与划选引用同口径。迁移来的旧消息可能没有 */
  turn?: number;
  /** 谁说的 */
  role: QuoteRole;
  /** 摘下的时刻（epoch ms） */
  createdAt: number;
}

/** 列表的一行：摘抄 + 出处会话标题（null = 会话已删，不可跳转）。 */
export interface ExcerptItem {
  excerpt: Excerpt;
  sessionTitle: string | null;
}

export interface ExcerptAddRequest {
  sessionId: string;
  turn?: number;
  role: QuoteRole;
  text: string;
}
/**
 * 同一会话、同一轮、同一角色、同一段文字（首尾空白与内部空白折叠后相同）再摘一次
 * 是幂等的：返回已有那条，duplicate = true，界面据此说「已经摘过」。
 */
export interface ExcerptAddResponse {
  excerpt: Excerpt;
  duplicate: boolean;
}

/** 全部摘抄，新的在前（会话过滤与搜索在 renderer 做——量小，一次拉全）。 */
export interface ExcerptListResponse {
  items: ExcerptItem[];
}

export interface ExcerptRemoveRequest {
  id: string;
}
/** removed = false：这个 id 不在（含连点两下的第二次），界面同样当作已删。 */
export interface ExcerptRemoveResponse {
  removed: boolean;
}

export const excerptChannels = {
  add: "excerpt:add",
  list: "excerpt:list",
  remove: "excerpt:remove",
} as const;

/** 单条摘抄的长度上限（字符）。超过的截断——划选整篇长回答存进来没有意义。 */
export const EXCERPT_MAX_CHARS = 4000;
