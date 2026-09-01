/**
 * 输入卡底栏的用量文案 —— 纯函数，node --test 可直接加载。
 *
 * 阶梯与「cost 只在 >0 时显示」沿用 pi TUI footer 的惯例（footer.ts formatTokens）：
 * 自建网关的模型定价是全零兜底，把「定价未知」显示成 $0.000 会误读为免费。
 * 上下文配色阈值也是 pi 的：>70% warning、>90% danger——颜色是第二信号。
 */
import type { ContextUsage, SessionStats } from "@earendil-works/pi-coding-agent";

/**
 * token 数的紧凑写法：18.2k / 142k / 1.2M。999 以内原样（session 里零星小数字不值得缩写）。
 * 阶梯学 pi 的 footer，但一位小数放宽到 100k——它在 10k 就取整是为了终端宽度，
 * 桌面底栏不用省这一两个字符（`18.2k / 200k` 是批次文档定的演示格式）。
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

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
