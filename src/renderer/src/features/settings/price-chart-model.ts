/**
 * 价格 · 能力图的纯函数（PriceCapabilityChart.tsx 只画）：显示门槛、帕累托前沿、坐标轴与刻度、
 * 数字格式、分类循环。数据口径在主进程（main/usage/price-chart.ts），这里不碰。
 */
import type { PriceChartCategory, PriceChartPoint, PriceChartScoreUnit } from "@shared/price-chart";
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名
import { PRICE_CHART_CATEGORIES } from "../../../../shared/price-chart.ts";
import type { ProviderDto } from "@shared/provider";

/** 所有服务商加起来已添加的型号数（同一型号挂在两家算两个） */
function addedModelCount(providers: readonly Pick<ProviderDto, "models">[]): number {
  return providers.reduce((sum, provider) => sum + provider.models.declared.length, 0);
}

/** 少于 2 个型号没有可比的对象：整块不出现（2026-10-24 裁决） */
export function shouldShowPriceChart(providers: readonly Pick<ProviderDto, "models">[]): boolean {
  return addedModelCount(providers) >= 2;
}

/** 左右按钮循环切分类 */
export function cycleCategory(current: PriceChartCategory, step: 1 | -1): PriceChartCategory {
  const index = PRICE_CHART_CATEGORIES.indexOf(current);
  const next = (index + step + PRICE_CHART_CATEGORIES.length) % PRICE_CHART_CATEGORIES.length;
  return PRICE_CHART_CATEGORIES[next] ?? current;
}

/**
 * 帕累托前沿：按花费从低到高扫，只留「比所有更便宜的点分数都高」的点——同等花费分数最高、
 * 再往上找更高分就要花更多钱。花费相同的按分数从高到低先扫，只有最高的那个能进前沿。
 */
export function paretoFrontier<T extends Pick<PriceChartPoint, "cost" | "score">>(points: readonly T[]): T[] {
  const sorted = [...points].sort((a, b) => a.cost - b.cost || b.score - a.score);
  const out: T[] = [];
  let best = Number.NEGATIVE_INFINITY;
  for (const point of sorted) {
    if (point.score > best) {
      out.push(point);
      best = point.score;
    }
  }
  return out;
}

export interface AxisRange {
  min: number;
  max: number;
}

/**
 * 横轴（对数）：在数据两端各留 0.15 个数量级，至少跨一个数量级——只有一两个点时也不贴边、
 * 刻度不至于只剩一个。
 */
export function costRange(costs: readonly number[]): AxisRange {
  const logs = costs.filter((c) => c > 0).map((c) => Math.log10(c));
  if (logs.length === 0) return { min: 0.01, max: 1 };
  let lo = Math.min(...logs) - 0.15;
  let hi = Math.max(...logs) + 0.15;
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  return { min: 10 ** lo, max: 10 ** hi };
}

/** 对数轴刻度：1-2-5 序列里落在范围内的；太密（> 8 个）就只留 1 与 5 */
export function costTicks(range: AxisRange): number[] {
  const out: number[] = [];
  for (let exp = Math.floor(Math.log10(range.min)); exp <= Math.ceil(Math.log10(range.max)); exp += 1) {
    for (const m of [1, 2, 5]) {
      const value = m * 10 ** exp;
      if (value >= range.min && value <= range.max) out.push(value);
    }
  }
  if (out.length <= 8) return out;
  return out.filter((value) => {
    const lead = Math.round(value / 10 ** Math.floor(Math.log10(value) + 1e-9));
    return lead !== 2;
  });
}

/** 纵轴（线性）：上下各留 8%，一个点也撑出一段高度 */
export function scoreRange(scores: readonly number[], unit: PriceChartScoreUnit): AxisRange {
  if (scores.length === 0) return unit === "rating" ? { min: 1400, max: 1500 } : { min: -0.05, max: 0.05 };
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const span = hi - lo || (unit === "rating" ? 40 : 0.04);
  return { min: lo - span * 0.08 - (hi === lo ? span / 2 : 0), max: hi + span * 0.08 + (hi === lo ? span / 2 : 0) };
}

/** 线性轴刻度：1-2-5 步长，大约 5 格 */
export function scoreTicks(range: AxisRange): number[] {
  const raw = (range.max - range.min) / 5;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * exp).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(range.min / step) * step; v <= range.max + 1e-12; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/** 每任务成本：≥ 10 美元不带小数，≥ 1 两位，< 1 两位有效数字（$0.031） */
export function formatCost(cost: number): string {
  if (cost >= 10) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(2)}`;
  return `$${cost.toPrecision(2)}`;
}

/** 横轴刻度：1-2-5 的整值不带多余的零（$0.05、$1、$20） */
export function formatCostTick(value: number): string {
  return `$${Number(value.toPrecision(1))}`;
}

/** 分数：Bradley-Terry 取整；net improvement 显示成带符号的百分比（0.0157 → +1.6%） */
export function formatScore(score: number, unit: PriceChartScoreUnit): string {
  if (unit === "rating") return String(Math.round(score));
  const pct = score * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** 点的身份（型号 × 档：同一型号挂几家服务商都是一个点） */
export function pointKey(point: Pick<PriceChartPoint, "modelId" | "thinkingLevel">): string {
  return `${point.modelId}\u0000${point.thinkingLevel ?? "none"}`;
}

/**
 * 点开的详情卡放在点的哪一侧（点的坐标是绘图区内的百分比，0 在左 / 上）：靠右的点卡片翻到左边、
 * 靠上的往下放、靠下的往上放，中间的上下居中——卡片不出绘图区的边。
 */
export function popoverPlacement(
  x: number,
  y: number,
): { side: "left" | "right"; vertical: "above" | "middle" | "below" } {
  return {
    side: x > 55 ? "left" : "right",
    vertical: y < 30 ? "below" : y > 70 ? "above" : "middle",
  };
}
