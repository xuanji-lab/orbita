/**
 * 用户情境（user context）—— 发往模型的每条用户消息前面**临时**附上的一段元信息，
 * 目前只有一项：这条消息是什么时间、什么时区发出的。
 *
 * 为什么做：pi 的系统提示词里没有日期时间，模型感知不到「现在几点」，而时间
 * 恰恰是理解用户消息的常见语境（深夜的「先这样吧」、周五下午的「下周再弄」）。
 * 这是「让模型感知更多用户情境」的第一个落点：之后要引入的健康数据、位置 /
 * 使用环境（手机端户外使用等）都往 `UserContext` 这个结构里加字段——加字段是
 * 加法，现在不做注册表 / 插件机制 / 空字段占位（AGENTS.md「避免过度抽象」：
 * 没有第二个消费者就不建抽象层）。
 *
 * 注入位置选 **wire 层**（pi 扩展的 `context` 事件，即 transformContext），
 * 不拼进 `session.prompt` 的正文：
 * - 界面转录与 pi 本子都不落这段——`context` 事件拿到的是 structuredClone 出来的
 *   副本，替换的只是发往 provider 的那份（image-byte-budget 的 wire-only 同款）；
 * - **前缀缓存逐字节稳定**（prompt cache 按请求前缀命中）：情境文本由消息自带的
 *   `timestamp`（发送时刻定格，不随轮次重算）+ 本轮开机时解析的 IANA 时区经纯函数
 *   生成，同一份历史每轮重放结果完全相同；
 * - 不碰回声对账（runtime 的 `echoed` 按用户正文全等）、不碰撤回 / 引用 / 粘贴块
 *   的文本解析——那些都吃转录原文，原文里没有这段。
 *
 * 被否决的方案：拼进 prompt 正文（随 pi 本子永久落盘）。那样 pi 的 JSONL 里每条
 * 用户消息都带着这段机器话，read_task 的会话索引、回退预览、后续任何吃 pi 本子
 * 文本的地方都得绕开它；而且将来格式升级时，历史消息冻着旧格式、新消息带新格式，
 * 混排不一致。wire 层每轮重算则永远只有一种格式。
 *
 * 纯模块：不 import electron、不 import 进程相关的东西，可被 `node --test` 直接加载。
 */
import type { ContextMessage } from "./image-byte-budget.ts";

/** 一条用户消息发出时的情境。字段是加法：健康数据、位置等将来在这里加。 */
export interface UserContext {
  /** 消息发出时刻（epoch 毫秒）——取消息自带的 timestamp，保证重放一致 */
  sentAt: number;
  /** IANA 时区名（如 `Asia/Shanghai`），由运行环境解析 */
  timeZone: string;
}

/**
 * 情境文本的样子（英文键名 + 本地化时间，中英文模型都读得懂）：
 *
 * ```
 * <user_context>
 * sent_at: 2026-10-12 02:31 Sun (Asia/Shanghai)
 * </user_context>
 * ```
 *
 * 标签名与键名固定为英文小写；日期数字用 `en-US` 的 2-digit 部件手工拼装，
 * 与运行环境 locale 无关——同一份输入在任何机器上字节相同（前缀缓存的硬要求）。
 */
export function formatUserContext(ctx: UserContext): string {
  return `<user_context>\nsent_at: ${formatSentAt(ctx.sentAt, ctx.timeZone)} (${ctx.timeZone})\n</user_context>`;
}

/** `YYYY-MM-DD HH:mm 周几缩写`，按 ctx.timeZone 呈现（不带秒——分钟粒度够模型用了） */
function formatSentAt(sentAt: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // 显式 h23：hour12:false 在部分 ICU 上会产出 "24:xx"（hourCycle h24）
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = new Map<string, string>(
    fmt.formatToParts(new Date(sentAt)).map((part) => [part.type as string, part.value]),
  );
  const pad = (type: string, width = 2): string => (parts.get(type) ?? "").padStart(width, "0");
  return `${pad("year", 4)}-${pad("month")}-${pad("day")} ${pad("hour")}:${pad("minute")} ${parts.get("weekday") ?? ""}`.trimEnd();
}

/**
 * wire 层注入：给 `messages` 里每条真实用户消息（`role === "user"`）的正文前面
 * 追加一段情境文本。工具结果（`role === "toolResult"`）、assistant、custom 等角色
 * 原样放行——它们不是「用户发的话」。
 *
 * 返回 `{ messages }` 让 pi 替换发往 provider 的那份；没有任何用户消息时返回
 * `undefined`（不替换，省一次数组拷贝）。**不改动入参**（pi 传进来的虽是克隆，
 * 这里也按不可变对待，纯函数可测）。
 */
export function injectUserContext(
  messages: readonly ContextMessage[],
  timeZone: string,
): { messages: ContextMessage[] } | undefined {
  let touched = false;
  const next: ContextMessage[] = [];
  for (const message of messages) {
    const record = message as { role?: unknown; content?: unknown; timestamp?: unknown };
    if (
      record.role !== "user" ||
      typeof record.timestamp !== "number" ||
      !Number.isFinite(record.timestamp)
    ) {
      next.push(message);
      continue;
    }
    const prefix = formatUserContext({ sentAt: record.timestamp, timeZone });
    next.push(withPrefix(message, prefix));
    touched = true;
  }
  return touched ? { messages: next } : undefined;
}

/** 单条消息前面垫一段文本：块数组前插一个 text 块；字符串正文直接拼在前面。 */
function withPrefix(message: ContextMessage, prefix: string): ContextMessage {
  const record = message as { content?: unknown };
  if (typeof record.content === "string") {
    return { ...message, content: `${prefix}\n${record.content}` } as ContextMessage;
  }
  if (Array.isArray(record.content)) {
    return {
      ...message,
      content: [{ type: "text", text: prefix }, ...record.content],
    } as ContextMessage;
  }
  // 形状不认识（上游契约变了）：原样放行，宁可少一段情境也不毁一条消息
  return message;
}
