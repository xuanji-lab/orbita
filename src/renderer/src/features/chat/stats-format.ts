/**
 * 用量的显示口径 —— 数字变成人话。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 * 抽出来是因为这几条规则会被争论，而争论的东西必须能单测。
 *
 * `formatTokens` 不在这里：它在 `utils/format-tokens.ts`，设置面显示模型参数也要用
 * （第二个消费者出现才建那一层）。
 */
import type { AgentStats } from "../../../../shared/agent-ipc.ts";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { formatTokens } from "../../utils/format-tokens.ts";
import { messageSpeed } from "../../../../shared/message-speed.ts";
import type { Messages } from "../../messages-en.ts";

/** 用量环的一帧：`fill` 是 0–1 的弧长，null = 只画底环 */
export interface ContextRing {
  fill: number | null;
  /** 颜色是第二信号：过七成才提醒，过九成才报警——数字本身在悬停的分项里 */
  tone: "neutral" | "warning" | "danger";
  /** `aria-label` 用的一句话 */
  label: string;
}

/**
 * 底栏右侧那个环。它顶替了 `18.2k / 200k · $0.06` 那行字——文字每次都要读，
 * 环扫一眼就够，而且省下的宽度正好留给下一个芯片。
 *
 * 上下文占用未知时（压缩刚做完、下一次模型响应之前）**只画底环，不画弧**，
 * 不写 0：这一环存在的理由就是回答「离爆上下文还有多远」，答不上来时空着比编一个数诚实。
 * 花费**不进环**——它不是比例，进了分项菜单。
 *
 * 配色阈值 70 / 90 沿用 pi TUI footer 的惯例（`>70% warning`、`>90% danger`）。
 */
export function contextRing(stats: AgentStats | null, t: Messages): ContextRing {
  const usage = stats?.contextUsage ?? null;
  if (usage === null || usage.tokens === null || usage.contextWindow <= 0) {
    return { fill: null, tone: "neutral", label: t.stats.contextUnknown };
  }
  const ratio = Math.min(1, Math.max(0, usage.tokens / usage.contextWindow));
  const percent = usage.percent ?? Math.round(ratio * 100);
  return {
    fill: ratio,
    tone: percent > 90 ? "danger" : percent > 70 ? "warning" : "neutral",
    label: t.stats.contextRing(formatTokens(usage.tokens), formatTokens(usage.contextWindow), Math.round(percent)),
  };
}

/** 分项里的一行。`value` 是机器事实，界面用 mono 字体显示 */
export interface UsageRow {
  label: string;
  value: string;
}

/**
 * 分项明细。**缓存读写单列**——它们是「这条会话为什么比看起来便宜」的答案，
 * 折进 total 就看不见了。
 *
 * **花费只在两道门都过了才占一行**：
 *
 * 1. `billing !== "plan"`。包月制的那个数字是拿 API 价目表算出来的**估价**，
 *    跟用户这个月的账单毫无关系——Coding Plan 用户看到 `$` 第一反应是
 *    「我不是包月吗」（wafo 2026-09-03）。套餐还剩多少要另接厂商接口，今天不做；
 *    这里只负责**不说错话**。
 * 2. `cost > 0`。上一版没价目表时写「no price list」，于是那一行永远挂着、
 *    永远不会变——废话。写 `unknown` 是同一句废话换个说法，一并删。
 *
 * 不是删掉而是条件显示：按量计费的 provider 上它仍然是最该被看见的一行。
 * 四位小数——展开看的人要的正是底栏那几位被舍入掉的。
 */
export function usageBreakdown(
  stats: AgentStats | null,
  t: Messages,
  billing: "metered" | "plan" = "metered",
): UsageRow[] {
  if (stats === null) return [];
  const rows: UsageRow[] = [
    { label: t.stats.input, value: formatTokens(stats.tokens.input) },
    { label: t.stats.output, value: formatTokens(stats.tokens.output) },
    { label: t.stats.cacheRead, value: formatTokens(stats.tokens.cacheRead) },
    { label: t.stats.cacheWrite, value: formatTokens(stats.tokens.cacheWrite) },
    { label: t.stats.totalTokens, value: formatTokens(stats.tokens.total) },
  ];
  const usage = stats.contextUsage;
  if (usage !== null) {
    rows.push({
      label: t.stats.context,
      value:
        usage.tokens === null
          ? t.stats.unknownUntilReply
          : `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}` +
            (usage.percent === null ? "" : ` · ${Math.round(usage.percent)}%`),
    });
  }
  if (billing !== "plan" && stats.cost > 0) {
    rows.push({ label: t.stats.cost, value: `$${stats.cost.toFixed(4)}` });
  }
  return rows;
}

// ── token 速度（usage-speed-X）──
// 真值的家在**回答自己身上**：adapter 在终态帧上算好挂 `speed`，随 transcript
// 落盘、重开即回（归约器实测原样保留）。这里只有两样展示支援。

/** `42 tok/s`——整数，tok/s 是 agent 工具界的通用写法，不翻译 */
export function formatSpeed(speed: number, t: Messages): string {
  return t.stats.speed(Math.round(speed));
}

/** messageId → 生成起点（首个 streaming 帧的 adapter 时间戳）。Responding 行的估算分母。 */
const streamingStarts = new Map<string, number>();

/**
 * 事件入口记账（`recordToolFrame` 同款：useChatSession 的 progress 处理处调）。
 * 只记起点，幂等——增量帧重复到达不覆盖。真值不需要它（在帧上），Responding 行的
 * 流式估算需要「这条消息从什么时候开始生成」，而归约器只留最后一帧的时间戳。
 * ponytail: Map 无上限，一条消息几十字节。
 */
export function recordAssistantStart(item: TranscriptItem): void {
  if (item.role !== "assistant" || item.status !== "streaming") return;
  if (!streamingStarts.has(item.id)) streamingStarts.set(item.id, item.timestamp);
}

/** 这条消息的生成起点；没见过起点（中途才挂上 / 已落盘重开）返回 null。 */
export function streamingStart(messageId: string): number | null {
  return streamingStarts.get(messageId) ?? null;
}

/**
 * 回答上的速度标注：按**整轮**算——轮内各条 assistant 记录的 `usage.output` 与 adapter
 * 挂在终态帧上的 `genMs`（纯生成毫秒）各自求和，再过同一道噪音门。
 * 单条算不代表这轮：末条常常只有十几个 token、几百毫秒，永远过不了门（验收复现）。
 * `genMs` 不在 pi 的 schema 类型上（归约器实测原样保留），按运行时形态读；
 * 没挂的记录（旧会话）两边都不计，全部没挂就 null——不编。
 */
export function replySpeed(
  records: readonly { role: unknown; usage?: unknown }[],
): number | null {
  let outputTokens = 0;
  let genMs = 0;
  for (const record of records) {
    if (record.role !== "assistant") continue;
    const ms = (record as { genMs?: unknown }).genMs;
    const usage = (record as { usage?: { output?: unknown } }).usage;
    const output = usage?.output;
    if (typeof ms !== "number" || !(ms >= 0) || typeof output !== "number") continue;
    genMs += ms;
    outputTokens += output;
  }
  return messageSpeed(genMs, outputTokens);
}
