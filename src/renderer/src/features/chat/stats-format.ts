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

/**
 * 花费段：`$0.062`（3 位小数——短会话的亚分级花费有意义）。
 * **0 或未知定价 → null**：自建网关的模型定价是全零兜底，
 * 把「定价未知」显示成 `$0.000` 会误读为免费。
 */
export function costText(cost: number): string | null {
  return cost > 0 ? `$${cost.toFixed(3)}` : null;
}

/** 分项里的一行。`value` 是机器事实，界面用 mono 字体显示 */
export interface UsageRow {
  label: string;
  value: string;
}

/**
 * 用量分项。**顺序是「花了多少钱 → 进去多少 → 出来多少 → 缓存」**：
 * 钱在最前面，因为那是唯一一个用户会拿去做决定的数。
 *
 * 缓存两项**都是 0 就整个不显示**——没用上缓存的 provider（多数国产网关）
 * 不该在菜单里挂两行零，那是噪音。
 *
 * 花费未知时写 `unknown` 而不是 `$0.000`，同 `costText` 的理由。
 */
export function usageBreakdown(stats: AgentStats | null): UsageRow[] {
  if (stats === null) return [];
  const rows: UsageRow[] = [
    { label: "Cost", value: costText(stats.cost) ?? "unknown" },
    { label: "Input", value: formatTokens(stats.tokens.input) },
    { label: "Output", value: formatTokens(stats.tokens.output) },
  ];
  if (stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0) {
    rows.push({ label: "Cache read", value: formatTokens(stats.tokens.cacheRead) });
    rows.push({ label: "Cache write", value: formatTokens(stats.tokens.cacheWrite) });
  }
  return rows;
}
