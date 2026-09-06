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
export function contextRing(stats: AgentStats | null): ContextRing {
  const usage = stats?.contextUsage ?? null;
  if (usage === null || usage.tokens === null || usage.contextWindow <= 0) {
    return { fill: null, tone: "neutral", label: "Context usage · unknown until next reply" };
  }
  const ratio = Math.min(1, Math.max(0, usage.tokens / usage.contextWindow));
  const percent = usage.percent ?? Math.round(ratio * 100);
  return {
    fill: ratio,
    tone: percent > 90 ? "danger" : percent > 70 ? "warning" : "neutral",
    label: `Context ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} · ${Math.round(percent)}%`,
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
 *
 * `speed` 是最近一条落定消息的速度（`sessionSpeed`），null 时整行不出现——
 * 同一句「宁缺不编」：没有事实的行不占地方（`Speed` 紧跟 `Total tokens`，
 * 都是「这轮花了多少」的量词，Context 是另一码事）。
 */
export function usageBreakdown(
  stats: AgentStats | null,
  billing: "metered" | "plan" = "metered",
  speed: number | null = null,
): UsageRow[] {
  if (stats === null) return [];
  const rows: UsageRow[] = [
    { label: "Input", value: formatTokens(stats.tokens.input) },
    { label: "Output", value: formatTokens(stats.tokens.output) },
    { label: "Cache read", value: formatTokens(stats.tokens.cacheRead) },
    { label: "Cache write", value: formatTokens(stats.tokens.cacheWrite) },
    { label: "Total tokens", value: formatTokens(stats.tokens.total) },
  ];
  if (speed !== null) rows.push({ label: "Speed", value: formatSpeed(speed) });
  const usage = stats.contextUsage;
  if (usage !== null) {
    rows.push({
      label: "Context",
      value:
        usage.tokens === null
          ? "unknown until next reply"
          : `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}` +
            (usage.percent === null ? "" : ` · ${Math.round(usage.percent)}%`),
    });
  }
  if (billing !== "plan" && stats.cost > 0) {
    rows.push({ label: "Cost", value: `$${stats.cost.toFixed(4)}` });
  }
  return rows;
}

// ── token 速度（usage-speed-X）──

/**
 * 速度行的口径：**最近一条落定 assistant 消息**的真值速度。
 *
 * 分子 = 终态帧 `usage.output`（provider 真值）；分母 = `item_started → item_finished`
 * 两帧的 adapter 时间戳差（同钟盖章，纯模型生成时间——工具执行、等批准天然剔除）。
 * 口径与被否方案见 `docs/plans/2026-09-06-usage-speed.md`。
 */

/**
 * 生成不足 500ms 的消息不参与——除以极小时间会出「167 tok/s」这种荒谬瞬时值
 * （读完小文件后的短消息就是这种）。500ms 是 Reasonix 验证过的噪音线。
 */
const SPEED_MIN_MS = 500;

/** 纯函数：tok/s；输出 0、时长不足门控或不合法返回 null（调用方沿用上一条的值）。 */
export function messageSpeed(startTs: number, endTs: number, outputTokens: number): number | null {
  const ms = endTs - startTs;
  if (!(ms >= SPEED_MIN_MS) || !(outputTokens > 0)) return null;
  return outputTokens / (ms / 1000);
}

/** `42 tok/s`——整数，tok/s 是 agent 工具界的通用写法，不翻译 */
export function formatSpeed(speed: number): string {
  return `${Math.round(speed)} tok/s`;
}

/** messageId → 生成起点（首个 streaming 帧的 adapter 时间戳）。终态帧算完即删。 */
const assistantStarts = new Map<string, number>();

/** sessionId → 最近一条落定消息的速度。旧会话没有条目，行就不出现（诚实未知）。 */
const latestSpeeds = new Map<string, number>();

/**
 * 事件入口记账（`recordToolFrame` 同款：useChatSession 的 progress 处理处调）。
 * streaming 帧记起点（幂等：增量帧重复到达不覆盖）；终态帧（complete / error 一视
 * 同仁——打断的速度也是真实速度，有 usage 就算）算真值存进 `latestSpeeds`。
 * 没见过起点（renderer 中途才挂上）或终态帧没 usage，就不动旧值——宁缺不编。
 * ponytail: 两个 Map 无上限，起点记完即删、速度每会话一个数，各几十字节。
 */
export function recordAssistantFrame(sessionId: string, item: TranscriptItem): void {
  if (item.role !== "assistant") return;
  if (item.status === "streaming") {
    if (!assistantStarts.has(item.id)) assistantStarts.set(item.id, item.timestamp);
    return;
  }
  const start = assistantStarts.get(item.id);
  assistantStarts.delete(item.id);
  if (start === undefined || item.usage === undefined) return;
  const speed = messageSpeed(start, item.timestamp, item.usage.output);
  if (speed !== null) latestSpeeds.set(sessionId, speed);
}

/** 这条会话最近一次算出的速度；没见过现场返回 null（行不出现）。 */
export function sessionSpeed(sessionId: string): number | null {
  return latestSpeeds.get(sessionId) ?? null;
}
