/**
 * MCP 面板行的派生（纯函数，与 tool-chips.ts 同一条纪律：算与渲染分开）。
 *
 * 分片之后一行背后可能是几个工作区实例。头行图标与状态行都由这份汇总派生——
 * 不让「一个实例的失败被另一个实例的就绪遮住」（合并状态取最优的撒谎点：
 * paper3 就绪 + 写稿失败 → 合并出就绪，红字消失了）。
 */
import type { McpInstanceInfo, McpStatus } from "@shared/mcp";

export interface InstanceSummary {
  /** 实例总数（Home 实例已被主进程滤掉，这里全是工作区实例） */
  total: number;
  ready: number;
  /** 连接失败的工作区名（按实例顺序） */
  failed: string[];
}

export function summarizeInstances(instances: McpInstanceInfo[]): InstanceSummary {
  let ready = 0;
  const failed: string[] = [];
  for (const instance of instances) {
    if (instance.status.kind === "ready") ready += 1;
    if (instance.status.kind === "failed") failed.push(instance.workspace);
  }
  return { total: instances.length, ready, failed };
}

/**
 * 头行图标的 kind：有实例失败就按 failed 画（红三角），哪怕合并状态是就绪——
 * 颜色是第二信号，但「没有失败」这个信号本身不能撒谎。其余情况照原状态。
 */
export function headIconKind(status: McpStatus, summary: InstanceSummary): McpStatus["kind"] {
  if (summary.failed.length > 0) return "failed";
  return status.kind;
}

/**
 * 实例状态行（卡内独占一行，不挤头行——320px 抽屉的宽度预算决定的）。
 * null = 不显示：没有实例（还没连过），或全灭（卡片错误块接管，不重复说一遍）。
 */
export function statusLine(summary: InstanceSummary): InstanceSummary | null {
  if (summary.total === 0) return null;
  if (summary.ready === 0 && summary.failed.length > 0) return null;
  return summary;
}
