/**
 * 遗留事项带上下文续跑（面板的「继续」入口）——纯函数：种子消息组装与
 * 原会话续跑的可用性判断。
 *
 * ## 种子消息形态（本 PR 的核心决策）
 *
 * **发一条可见的结构化 user 消息直接开工**，不走 visibility: internal：
 *
 * - internal 是「系统注入的内部 prompt」（收尾扫描的指令语义），把用户的任务
 *   开工伪装成系统指令是语义错位；更实际的是 internal 不渲染——用户会看到
 *   agent 凭空开始回答，上下文从哪来的不可见，违背可追溯的纪律。
 * - 标题链路自动成立：首行截断即标题（derived），auto-title 稍后还会生成概括
 *   （derived 允许再试）；recentQueries 记录它也成立——它确实是这单任务的
 *   起点提问。
 * - 「播种 + 等用户触发」被否：多一步操作，违背「一键开工」的承诺。
 *
 * ## 上下文为什么是 title + detail，不带 transcript 片段
 *
 * detail 本身就是收尾扫描时 agent 从对话里摘的**原句或概括**——它是相关片段的
 * 人工策展版，比按 sourceMessageRange 机械切一段 transcript 更相关（锚点还是
 * 尽力而为的，常为 null）。为凑「片段」再拉一次全量 transcript 不值，降级为
 * title + detail 组合。
 *
 * 只做 type import（无运行时依赖）：node --test 直接加载本文件，
 * `@shared` 别名只在构建期由 electron-vite 解析。
 */
import type { Carryover, SessionMeta } from "@shared/session";

/**
 * 方案 A 的种子：新会话的首条 user 消息。sourceTitle 为 null 表示来源会话
 * 已删除（措辞退到无来源版——种子仍带 title / detail，上下文还在，只是交代
 * 不了出处）。
 */
export function buildCarryoverSeed(item: Carryover, sourceTitle: string | null): string {
  const lead =
    sourceTitle === null
      ? "继续处理一条遗留事项（来源任务已删除）："
      : `继续处理任务「${sourceTitle}」收尾时留下的遗留事项：`;
  const detail = item.detail === "" ? "" : `\n\n当时的上下文摘录：${item.detail}`;
  return `${lead}\n\n${item.title}${detail}\n\n请基于以上上下文接手这件事，继续推进直至完成。`;
}

/**
 * 方案 B 的消息：发进**原会话**的用户消息。原对话就在场，不需要交代来源
 * 标题——只点名这件事并要求接着做完。
 */
export function buildCarryoverFollowUp(item: Carryover): string {
  const detail = item.detail === "" ? "" : `\n\n当时的上下文摘录：${item.detail}`;
  return `继续处理这件收尾时留下的遗留事项：\n\n${item.title}${detail}\n\n请接着把它做完。`;
}

/**
 * 方案 B 的可用性：来源会话存在**且有 pi 本子**（`piSessionFile !== null` 才能续跑；
 * 导入的只读会话没有本子，消息无处可发）。面板按它禁用右键入口。
 */
export function canResumeInSource(item: Carryover, sessions: readonly SessionMeta[]): boolean {
  const meta = sessions.find((entry) => entry.id === item.sourceSessionId);
  return meta !== undefined && meta.piSessionFile !== null;
}
