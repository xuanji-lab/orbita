/**
 * 输入卡底栏的用量文案 —— 纯函数，node --test 可直接加载。
 *
 * 「cost 只在 >0 时显示」沿用 pi TUI footer 的惯例：
 * 自建网关的模型定价是全零兜底，把「定价未知」显示成 $0.000 会误读为免费。
 * 上下文配色阈值也是 pi 的：>70% warning、>90% danger——颜色是第二信号。
 */
import type { ContextUsage, SessionStats } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "../../utils/format-tokens.ts";

/**
 * 上下文段：`18.2k / 200k`。tokens 为 null（刚压缩完、还没有下一次 LLM 响应）时
 * 显示 `? / 200k`——诚实未知优于过期的数字。
 */
export function contextText(usage: ContextUsage): string {
  const used = usage.tokens === null ? "?" : formatTokens(usage.tokens);
  return `${used} / ${formatTokens(usage.contextWindow)}`;
}

/** 花费段：`$0.062`（3 位小数，短会话的亚分级花费有意义）。0 或未知定价 → null（不显示）。 */
export function costText(cost: number): string | null {
  return cost > 0 ? `$${cost.toFixed(3)}` : null;
}

/** 上下文用量配色。percent 未知（null）不叫唤——? 不染红。 */
export function contextTone(percent: number | null): "default" | "warning" | "danger" {
  if (percent === null) return "default";
  if (percent > 90) return "danger";
  if (percent > 70) return "warning";
  return "default";
}

/** hover 分项（原生 title，英文标签——语言模式立项统一切文案时一起换）。 */
export function statsTitleText(stats: SessionStats): string {
  return [
    `input ${formatTokens(stats.tokens.input)}`,
    `output ${formatTokens(stats.tokens.output)}`,
    `cache read ${formatTokens(stats.tokens.cacheRead)}`,
    `cache write ${formatTokens(stats.tokens.cacheWrite)}`,
  ].join("\n");
}
