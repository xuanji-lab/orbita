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
 */
export function usageBreakdown(
  stats: AgentStats | null,
  billing: "metered" | "plan" = "metered",
): UsageRow[] {
  if (stats === null) return [];
  const rows: UsageRow[] = [
    { label: "Input", value: formatTokens(stats.tokens.input) },
    { label: "Output", value: formatTokens(stats.tokens.output) },
    { label: "Cache read", value: formatTokens(stats.tokens.cacheRead) },
    { label: "Cache write", value: formatTokens(stats.tokens.cacheWrite) },
    { label: "Total tokens", value: formatTokens(stats.tokens.total) },
  ];
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
